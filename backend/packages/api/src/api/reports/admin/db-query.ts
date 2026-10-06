import { createPgConnection } from '@medusajs/framework/utils';
import { redact } from './proxy';

// Read-only SQL for the desk bots (POST /reports/admin/sql): the owner's call
// on 2026-10-06 was "just give it everything", read-only, so any desk key may
// run one query against the live database. It runs as the app's own database
// user, so the guarantees are layered rather than one role's grants:
//
//   - Postgres refuses every write: the query runs in a READ ONLY transaction
//     on a connection of its own, closed afterwards. That also refuses row
//     locks (FOR UPDATE) and nextval/setval.
//   - One statement only: every statement carrying the query also carries a
//     bound parameter, so Postgres parses it as a prepared statement, which
//     refuses a second command after a semicolon.
//   - It runs as a subquery, so only a query expression parses: no SET, no
//     data-modifying WITH.
//   - The few functions a read-only transaction still runs that reach beyond
//     the query (other sessions, server files and settings, locks, SQL run
//     from a string), the tables holding passwords, login tokens and reset
//     links, and any mention of a password are refused before anything runs.
//   - Secrets never leave: every stored partner login password is masked in
//     the answer and in any error message, however the query reshaped it
//     (a jsonb column cast to text, say), and any password, token or key
//     field is hidden by name, inside JSON text too.
//   - Bounded: 20 s, 500 rows, 16 KB a row and 1 MB in all, built as JSON by
//     Postgres so the web process never holds more than that; one query at a
//     time per server, at most two waiting. The site's own connection pool is
//     never touched.

export const MAX_ROWS = 500;
const MAX_SQL = 8_000;
const MAX_ROW_BYTES = 16_000;
const MAX_JSON_BYTES = 1_000_000;
// What the bot gets: Hermes spills a tool result over 50K characters to a
// file the bot cannot read.
export const MAX_ANSWER_CHARS = 38_000;

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
    // Every session's live SQL, client address and application.
    'pg_stat_activity',
    'pg_stat_get_\\w*activity\\w*',
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
  ].join('|')})\\b`,
  'i',
);
// Password hashes, API keys, invite, reset, verification and MFA tokens, and
// notification contents (reset links).
const REFUSED_TABLES =
  /\b(provider_identity|api_key|(?:member_)?invite|notification|workflow_execution|auth_(?:verification|mfa|password_reset)\w*)\b/i;
// Partner logins keep their generated password in customer.metadata.
const PASSWORDS = /\b\w*(password|partner_credential)\w*\b/i;
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
  if (UNICODE_ESCAPES.test(sql)) {
    return 'Unicode-escaped names (U&"...") are not accepted: write names plainly.';
  }
  return null;
}

/** The query as a capped subquery: $1 is the row cap. The newlines keep a
 *  trailing -- comment from swallowing the closing paren. */
export const wrapQuery = (sql: string): string =>
  `SELECT * FROM (\n${sql.trim().replace(/;+$/, '')}\n) AS desk_bot_query LIMIT $1`;

/** The rows as one JSON text built by Postgres: rows over $2 bytes are
 *  counted instead of sent, and a total over $3 bytes comes back null, so
 *  the web process never holds a big answer. JSON also keeps every value as
 *  Postgres shows it (a timestamp without time zone stays one). */
export const dataQuery = (sql: string): string =>
  'SELECT CASE WHEN octet_length(t.j) <= $3 THEN t.j END AS rows, ' +
  'octet_length(t.j) AS bytes, t.n, t.too_big FROM (' +
  "SELECT coalesce(json_agg(q) FILTER (WHERE pg_column_size(q) <= $2), '[]')::text AS j, " +
  'count(*)::int AS n, count(*) FILTER (WHERE pg_column_size(q) > $2)::int AS too_big ' +
  `FROM (${wrapQuery(sql)}) AS q) AS t`;

// Every partner login password stored where the bots can read (fetched in
// the query's own transaction, so it is the same snapshot the query sees).
const SECRET_VALUES_SQL =
  "SELECT DISTINCT metadata->'partner_credential'->>'password' AS s FROM customer WHERE metadata ? 'partner_credential'";

/** `text` with every secret value replaced by [hidden], as written and as
 *  JSON escapes it (a value inside JSON text). */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      out = out.split(form).join('[hidden]');
    }
  }
  return out;
}

/** What the bot is sent: the counts first and as many whole rows as fit, so a
 *  cut answer still says it is cut. */
export function fitAnswer(
  columns: string[],
  rows: unknown[],
  moreRows: boolean,
  ms: number,
  maxChars = MAX_ANSWER_CHARS,
) {
  const head = { columns, row_count: rows.length, more_rows: moreRows, ms };
  // Room for the rows_shown count and the note.
  let size = JSON.stringify({ ...head, rows: [] }).length + 300;
  const shown: unknown[] = [];
  for (const row of rows) {
    size += JSON.stringify(row).length + 1;
    if (size > maxChars) break;
    shown.push(row);
  }
  if (shown.length === rows.length) return { ...head, rows: shown };
  return {
    ...head,
    rows_shown: shown.length,
    note: `Only the first ${shown.length} of ${rows.length} rows fit in one answer. Ask again narrower: aggregate in SQL (COUNT, SUM, GROUP BY), select fewer columns, or add LIMIT and OFFSET.`,
    rows: shown,
  };
}

/** A refusal found while running: the bot is told why, with a 400. */
export class SqlRefused extends Error {}
/** More queries waiting than this server takes: a 429. */
export class SqlBusy extends Error {}
/** The caller left before its turn: nothing to answer. */
export class SqlCallerGone extends Error {}

export type SqlAnswer = ReturnType<typeof fitAnswer>;

// The slices of knex and node-postgres used here.
type PgResult = {
  rows: Record<string, unknown>[];
  fields: { name: string }[];
};
type PgClient = {
  query(q: {
    text: string;
    values?: unknown[];
    query_timeout?: number;
  }): Promise<PgResult>;
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

const MAX_WAITING = 2;
let waiting = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Runs `sql` (already past sqlRefusal) read-only, after any query still
 *  running on this server. `shared` is the app's PG_CONNECTION: its settings
 *  (the database URL and TLS) open the query's own connection. `gone` says
 *  whether the caller has left, checked when the query's turn comes. */
export function runReadOnlyQuery(
  shared: unknown,
  sql: string,
  timeoutMs: number,
  gone: () => boolean = () => false,
): Promise<SqlAnswer> {
  if (waiting >= MAX_WAITING) {
    return Promise.reject(
      new SqlBusy(
        'The database tool is busy with other questions. Try again in a minute.',
      ),
    );
  }
  waiting += 1;
  const run = queue.then(() => {
    waiting -= 1;
    if (gone()) throw new SqlCallerGone();
    return runNow(shared as Knexish, sql, timeoutMs);
  });
  // Keep the chain, not the answer.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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
  let secrets: string[] = [];
  try {
    const conn = await db.client.acquireConnection();
    // node-postgres gives up on any one statement after this, so a dead
    // connection cannot hold the queue: Postgres stops the query itself at
    // timeoutMs.
    const step = (text: string, values?: unknown[]) =>
      conn.query({ text, values, query_timeout: timeoutMs + 5_000 });
    try {
      // One round trip, no caller text, so the simple protocol is fine here.
      await step(
        'BEGIN TRANSACTION READ ONLY; ' +
          `SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}; ` +
          'SET LOCAL lock_timeout = 2000; ' +
          // Ends the transaction if this server vanishes mid-query.
          'SET LOCAL idle_in_transaction_session_timeout = 30000; ' +
          "SET LOCAL application_name = 'desk-bots-sql'",
      );
      secrets = (await step(SECRET_VALUES_SQL)).rows
        .map((r) => r.s)
        .filter((s): s is string => typeof s === 'string');
      // The columns first (LIMIT 0 runs nothing): rows are JSON objects, so
      // a name used twice would keep only one of its values.
      const columns = (await step(wrapQuery(sql), [0])).fields.map(
        (f) => f.name,
      );
      const twice = columns.find((c, i) => columns.indexOf(c) !== i);
      if (twice) {
        throw new SqlRefused(
          `Two columns are both named ${twice}: give each its own name with AS.`,
        );
      }
      const [result] = (
        await step(dataQuery(sql), [
          MAX_ROWS + 1,
          MAX_ROW_BYTES,
          MAX_JSON_BYTES,
        ])
      ).rows as {
        rows: string | null;
        bytes: number;
        n: number;
        too_big: number;
      }[];
      if (result.too_big > 0) {
        throw new SqlRefused(
          `${result.too_big} of the rows are over 16 KB each, too big to send. Select fewer or narrower columns (one field of a JSON column rather than all of it).`,
        );
      }
      if (result.rows === null) {
        throw new SqlRefused(
          `The answer is ${(result.bytes / 1e6).toFixed(1)} MB, too big to send. Ask again narrower: aggregate in SQL, select fewer columns, or add LIMIT.`,
        );
      }
      const rows = (
        JSON.parse(scrubSecrets(result.rows, secrets)) as unknown[]
      ).slice(0, MAX_ROWS);
      return fitAnswer(
        columns,
        redact(rows) as unknown[],
        result.n > MAX_ROWS,
        Date.now() - started,
      );
    } finally {
      await db.client.releaseConnection(conn);
    }
  } catch (err) {
    // Postgres repeats bad input in its errors (a cast's value, say).
    if (err instanceof Error) err.message = scrubSecrets(err.message, secrets);
    throw err;
  } finally {
    // Closing the connection ends the transaction: nothing is ever committed.
    // Not awaited: a dead socket must not hold the next query.
    void db.destroy().catch(() => undefined);
  }
}

// SQLSTATE classes that mean the database, not the query, failed: connection
// (08), resources (53), operator intervention (57, except 57014, our own
// timeout), system (58) and internal (XX) errors.
const UNAVAILABLE = /^(08|53|58|XX|57(?!014))/;

/** A Postgres error about the query as the sentence the bot gets, or null
 *  for any other failure (the database did not answer). */
export function sqlErrorMessage(err: unknown): string | null {
  const e = (err ?? {}) as {
    code?: unknown;
    message?: unknown;
    hint?: unknown;
    severity?: unknown;
  };
  // Only node-postgres's DatabaseError carries a severity; a socket error's
  // code (EPIPE) has the same shape as a SQLSTATE.
  if (typeof e.severity !== 'string' || typeof e.code !== 'string') {
    return null;
  }
  if (UNAVAILABLE.test(e.code)) return null;
  if (e.code === '57014') {
    return 'The query ran too long and was stopped. Narrow it: filter on an indexed column such as created_at or customer_id, aggregate in SQL, or add LIMIT.';
  }
  if (e.code === '25006') {
    return 'That would change the database (or lock rows): the desk bots can only read.';
  }
  const hint = typeof e.hint === 'string' && e.hint ? ` Hint: ${e.hint}` : '';
  const lookup =
    e.code === '42P01'
      ? " To list tables: SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'."
      : e.code === '42703'
        ? " To list a table's columns: SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '<table>'."
        : '';
  return `Postgres: ${String(e.message)}.${hint}${lookup}`;
}

/** The query as it is logged: every quoted value and long number masked, so
 *  an email, phone or bank number a bot filtered on never reaches the logs. */
export const sqlForLog = (sql: string): string =>
  sql
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "'…'")
    .replace(/'(?:[^']|'')*'/g, "'…'")
    .replace(/\d{5,}/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
