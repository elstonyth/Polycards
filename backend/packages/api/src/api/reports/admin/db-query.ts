import { createPgConnection } from '@medusajs/framework/utils';

// Read-only SQL for the desk bots (GET /reports/admin/sql): the owner's call
// on 2026-10-06 was "just give it everything", read-only, so any desk key may
// run one query against the live database. It runs as the app's own database
// user, so the guarantees are layered rather than one role's grants:
//
//   - Postgres refuses every write: the query runs in a READ ONLY transaction
//     on a connection of its own, closed afterwards.
//   - One statement only: the query travels with a bound parameter (the row
//     cap), so Postgres parses it as a prepared statement, which refuses a
//     second command after a semicolon.
//   - It runs as a subquery, SELECT * FROM (<query>) LIMIT 501, so only a
//     query expression parses: no SET, no data-modifying WITH.
//   - The few functions a read-only transaction still runs that reach beyond
//     the query (other sessions, server files and settings, locks, SQL run
//     from a string), the tables holding passwords, login tokens and reset
//     links, and any mention of a password are refused before anything runs.
//   - Stopped after 20 seconds, at most 500 rows, one query at a time per
//     server: the site's own 5-connection pool is never touched.

export const MAX_ROWS = 500;
// It travels in the URL, and Node refuses request headers over 16 KB.
const MAX_SQL = 8_000;

// Matched as whole words in any case, comments and strings included: a false
// alarm costs the bot a rephrase, a miss could stop the site.
const REFUSED_FUNCTIONS = new RegExp(
  `\\b(${[
    'pg_(?:terminate|cancel)_backend',
    'pg_reload_conf',
    'pg_rotate_logfile',
    'pg_promote',
    'pg_switch_wal',
    'pg_create_restore_point',
    'pg_(?:start_|stop_)?backup\\w*',
    'pg_stat_reset\\w*',
    'pg_read_\\w+',
    'pg_ls_\\w+',
    'pg_stat_file',
    'pg_file_\\w+',
    'pg_logical_\\w+',
    'pg_\\w*replication\\w*',
    'pg_\\w*advisory\\w*',
    'pg_sleep\\w*',
    'pg_notify',
    'pg_wal_\\w+',
    'pg_log_\\w+',
    'pg_import_\\w+',
    // Column statistics hold sample values of every column, the refused
    // tables' included.
    'pg_stats\\w*',
    'pg_statistic\\w*',
    'set_config',
    // These run SQL given as a string, which these checks cannot see.
    '\\w+_to_xml\\w*',
    'ts_stat',
    'ts_rewrite',
    'dblink\\w*',
    'lo_\\w+',
    'nextval',
    'setval',
  ].join('|')})\\b`,
  'i',
);
// Password hashes, API keys, invite, reset and MFA tokens, and notification
// contents (reset links).
const REFUSED_TABLES =
  /\b(provider_identity|api_key|(?:member_)?invite|notification|workflow_execution|auth_(?:verification|mfa_\w+|password_reset_token))\b/i;
// Partner logins keep their generated password in customer.metadata.
const PASSWORDS = /\b\w*(password|partner_credential)\w*\b/i;
// Real names (spec 2026-10-06): refused by NAME in the query, not only
// redacted by key in the result — an alias (`real_name AS n`) would walk
// straight past the key-based redaction.
const REAL_NAMES = /\breal_name\w*\b/i;
const ROW_LOCKS = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/i;
// U&"..." spells a name in escapes the checks above would not recognize.
const UNICODE_ESCAPES = /\bu&['"]/i;
const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const READ_START = /^(?:select|with|values|table|\()/i;

/** Why `sql` may not run, or null when it may. */
export function sqlRefusal(sql: unknown): string | null {
  if (typeof sql !== 'string' || sql.trim() === '') {
    return 'sql is required: one SELECT query.';
  }
  if (sql.length > MAX_SQL) {
    return `sql is too long (over ${MAX_SQL.toLocaleString('en-MY')} characters).`;
  }
  if (!READ_START.test(sql.replace(LEADING_COMMENTS, ''))) {
    return 'Only a read query runs here: start with SELECT or WITH. The desk bots can read the database but never change it.';
  }
  const fn = REFUSED_FUNCTIONS.exec(sql)?.[1];
  if (fn) {
    return `${fn} is not available to the desk bots: it reaches beyond reading data.`;
  }
  const table = REFUSED_TABLES.exec(sql)?.[1];
  if (table) {
    return `The ${table} table is not open to the desk bots: it holds passwords, login tokens or reset links.`;
  }
  if (PASSWORDS.test(sql)) return 'Passwords stay hidden from the desk bots.';
  if (REAL_NAMES.test(sql))
    return 'Customers’ real names stay hidden from the desk bots.';
  if (ROW_LOCKS.test(sql)) {
    return 'Row locks (FOR UPDATE, FOR SHARE) are not available: the query only reads.';
  }
  if (UNICODE_ESCAPES.test(sql)) {
    return 'Unicode-escaped names (U&"...") are not accepted: write names plainly.';
  }
  return null;
}

/** The query as it runs: a subquery capped by the one bound parameter. The
 *  newlines keep a trailing -- comment from swallowing the closing paren. */
export const wrapQuery = (sql: string): string =>
  `SELECT * FROM (\n${sql.trim().replace(/;+$/, '')}\n) AS desk_bot_query LIMIT $1`;

export type SqlAnswer = {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  more_rows: boolean;
  ms: number;
};

// The slices of knex and node-postgres used here.
type PgClient = {
  query(
    q: string | { text: string; values: unknown[] },
  ): Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }>;
};
type Knexish = {
  client: {
    config: {
      connection?: { connectionString?: string; ssl?: unknown };
      searchPath?: string;
    };
    acquireConnection(): Promise<PgClient>;
    releaseConnection(connection: PgClient): Promise<void>;
  };
  destroy(): Promise<void>;
};

let queue: Promise<unknown> = Promise.resolve();

/** Runs `sql` (already past sqlRefusal) read-only, after any query still
 *  running on this server. `shared` is the app's PG_CONNECTION: its settings
 *  (the database URL and TLS) open the query's own connection. */
export function runReadOnlyQuery(
  shared: unknown,
  sql: string,
  timeoutMs: number,
): Promise<SqlAnswer> {
  const run = queue.then(() =>
    // Postgres stops the query itself; this only keeps a dead connection
    // from holding up every later query.
    withDeadline(runNow(shared as Knexish, sql, timeoutMs), timeoutMs + 15_000),
  );
  queue = run.catch(() => undefined);
  return run;
}

const withDeadline = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The database did not answer in time.')),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });

async function runNow(
  shared: Knexish,
  sql: string,
  timeoutMs: number,
): Promise<SqlAnswer> {
  const { connection, searchPath } = shared.client.config;
  if (!connection?.connectionString) {
    throw new Error('The database settings are not available.');
  }
  const db = createPgConnection({
    clientUrl: connection.connectionString,
    schema: searchPath,
    driverOptions: { connection: { ssl: connection.ssl } },
    // A database that will not connect fails the query in 15 s, not knex's 60.
    pool: { min: 0, max: 1, acquireTimeoutMillis: 15_000 },
  }) as unknown as Knexish;
  const started = Date.now();
  try {
    const conn = await db.client.acquireConnection();
    try {
      await conn.query('BEGIN TRANSACTION READ ONLY');
      await conn.query(
        `SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`,
      );
      await conn.query('SET LOCAL lock_timeout = 2000');
      await conn.query("SET LOCAL application_name = 'desk-bots-sql'");
      const result = await conn.query({
        text: wrapQuery(sql),
        values: [MAX_ROWS + 1],
      });
      const rows = result.rows.slice(0, MAX_ROWS);
      return {
        columns: result.fields.map((f) => f.name),
        rows,
        row_count: rows.length,
        more_rows: result.rows.length > MAX_ROWS,
        ms: Date.now() - started,
      };
    } finally {
      await db.client.releaseConnection(conn);
    }
  } finally {
    // Closing the connection ends the transaction: nothing is ever committed.
    await db.destroy();
  }
}

/** A Postgres error as the sentence the bot gets, or null for any other
 *  failure (the database did not answer). */
export function sqlErrorMessage(err: unknown): string | null {
  const e = (err ?? {}) as {
    code?: unknown;
    message?: unknown;
    hint?: unknown;
  };
  if (typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) return null;
  if (e.code === '57014') {
    return 'The query ran too long and was stopped. Narrow it: filter on an indexed column such as created_at or customer_id, aggregate in SQL, or add LIMIT.';
  }
  if (e.code === '25006') {
    return 'That would change the database: the desk bots can only read.';
  }
  const hint = typeof e.hint === 'string' && e.hint ? ` Hint: ${e.hint}` : '';
  const tables =
    e.code === '42P01'
      ? " To list tables: SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'."
      : e.code === '42703'
        ? " To list a table's columns: SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '<table>'."
        : '';
  return `Postgres: ${String(e.message)}.${hint}${tables}`;
}
