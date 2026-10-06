import {
  dataQuery,
  fitAnswer,
  scrubSecrets,
  sqlErrorMessage,
  sqlForLog,
  sqlRefusal,
  wrapQuery,
} from '../db-query';

describe('sqlRefusal', () => {
  it.each([
    'SELECT count(*) FROM customer',
    "select id, email from customer where created_at > now() - interval '7 days'",
    'WITH paid AS (SELECT customer_id, sum(amount) s FROM credit_transaction GROUP BY 1) SELECT * FROM paid',
    'VALUES (1), (2)',
    'TABLE pack',
    '(SELECT 1) UNION (SELECT 2)',
    '-- the week so far\nSELECT 1',
    '/* totals */ SELECT 1;',
    "SELECT pg_size_pretty(pg_total_relation_size('pull'))",
    "SELECT metadata->>'handle' FROM customer",
    'SELECT * FROM notification_read',
    'SELECT * FROM gateway_withdrawal',
    'SELECT * FROM player_payout_details',
    'SELECT * FROM auth_identity',
    "SELECT * FROM customer WHERE metadata ? 'handle'",
    // Postgres refuses these itself in the READ ONLY transaction (25006):
    // a text check would only refuse "for update" inside a string as well.
    'SELECT * FROM pull FOR UPDATE',
    "SELECT nextval('seq')",
    "SELECT * FROM delivery_order WHERE note ILIKE '%for update%'",
  ])('runs %p', (sql) => {
    expect(sqlRefusal(sql)).toBeNull();
  });

  it.each([
    [undefined, /sql is required/],
    ['   ', /sql is required/],
    [['SELECT 1'], /sql is required/],
    [`SELECT '${'x'.repeat(8_001)}'`, /too long/],
    ['DELETE FROM customer', /Only a read query/],
    ['update pack set price = 0', /Only a read query/],
    ['-- sneaky\nDROP TABLE pull', /Only a read query/],
    ['SET statement_timeout = 0', /Only a read query/],
    [
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity',
      /pg_terminate_backend is not available/,
    ],
    ['SELECT PG_CANCEL_BACKEND(1)', /PG_CANCEL_BACKEND is not available/],
    ['SELECT "pg_sleep"(30)', /pg_sleep is not available/],
    [
      'SELECT pg_catalog.pg_advisory_lock(1)',
      /pg_advisory_lock is not available/,
    ],
    [
      "SELECT set_config('role', 'doadmin', true)",
      /set_config is not available/,
    ],
    [
      "SELECT query_to_xml('select 1', true, false, '')",
      /query_to_xml is not available/,
    ],
    [
      "SELECT table_to_xml('customer', true, false, '')",
      /table_to_xml is not available/,
    ],
    ["SELECT pg_read_file('/etc/passwd')", /pg_read_file is not available/],
    ['SELECT lo_import(1)', /lo_import is not available/],
    [
      "SELECT most_common_vals FROM pg_stats WHERE tablename = 'x'",
      /pg_stats is not available/,
    ],
    [
      'SELECT query, client_addr FROM pg_stat_activity',
      /pg_stat_activity is not available/,
    ],
    [
      'SELECT * FROM pg_stat_get_activity(NULL)',
      /pg_stat_get_activity is not available/,
    ],
    ['SELECT * FROM provider_identity', /provider_identity table is not open/],
    ['SELECT * FROM public."api_key"', /api_key table is not open/],
    ['SELECT token FROM invite', /invite table is not open/],
    ['SELECT * FROM member_invite', /member_invite table is not open/],
    ['SELECT data FROM notification', /notification table is not open/],
    [
      'SELECT * FROM auth_password_reset_token',
      /auth_password_reset_token table is not open/,
    ],
    [
      'SELECT * FROM auth_mfa_recovery_code',
      /auth_mfa_recovery_code table is not open/,
    ],
    [
      'SELECT entity_id, token_hash AS h FROM auth_verification_token',
      /auth_verification_token table is not open/,
    ],
    [
      'SELECT context FROM workflow_execution',
      /workflow_execution table is not open/,
    ],
    [
      "SELECT metadata->'partner_credential' FROM customer",
      /Passwords stay hidden/,
    ],
    [
      "SELECT metadata#>>'{partner_credential,password}' FROM customer",
      /Passwords stay hidden/,
    ],
    ['SELECT U&"\\0070g_sleep"(1)', /Unicode-escaped/],
    ['SELECT * FROM pull WHERE customer_id = $2', /Placeholders like \$1/],
  ])('refuses %p', (sql, why) => {
    expect(sqlRefusal(sql)).toMatch(why);
  });
});

describe('wrapQuery and dataQuery', () => {
  it('runs the query as a subquery capped by the bound row limit', () => {
    expect(wrapQuery('  SELECT 1;; ')).toBe(
      'SELECT * FROM (\nSELECT 1\n) AS desk_bot_query LIMIT $1',
    );
  });

  it('keeps a trailing comment off the closing paren', () => {
    expect(wrapQuery('SELECT 1 -- done')).toBe(
      'SELECT * FROM (\nSELECT 1 -- done\n) AS desk_bot_query LIMIT $1',
    );
  });

  it('has Postgres build the rows as JSON, bounded per row and in all', () => {
    const q = dataQuery('SELECT 1');
    expect(q).toContain(`FROM (${wrapQuery('SELECT 1')}) AS desk_bot_row`);
    // desk_bot_row.*: a column the query names q (or anything) is not the row.
    expect(q).toContain(
      'json_agg(desk_bot_row.*) FILTER (WHERE pg_column_size(desk_bot_row.*) <= $2)',
    );
    expect(q).toContain('CASE WHEN octet_length(t.j) <= $3 THEN t.j END');
  });
});

describe('scrubSecrets', () => {
  it('masks every stored secret, as written and as JSON escapes it', () => {
    const secrets = ['Ab3dEf7hJk9mNp2q', 'pa"ss\\word99'];
    expect(
      scrubSecrets(
        '{"metadata":"{\\"partner_credential\\": {\\"password\\": \\"Ab3dEf7hJk9mNp2q\\"}}","b":"pa\\"ss\\\\word99"}',
        secrets,
      ),
    ).toBe(
      '{"metadata":"{\\"partner_credential\\": {\\"password\\": \\"[hidden]\\"}}","b":"[hidden]"}',
    );
    expect(
      scrubSecrets(
        'invalid input syntax for type integer: "{... Ab3dEf7hJk9mNp2q ...}"',
        secrets,
      ),
    ).toBe('invalid input syntax for type integer: "{... [hidden] ...}"');
  });

  it('leaves values too short to be a password alone', () => {
    expect(scrubSecrets('a abc a', ['abc'])).toBe('a abc a');
  });
});

describe('fitAnswer', () => {
  it('sends a small answer whole, counts first and rows last', () => {
    const answer = fitAnswer(['n'], [{ n: 1 }, { n: 2 }], false, 12);
    expect(answer).toEqual({
      columns: ['n'],
      row_count: 2,
      more_rows: false,
      ms: 12,
      rows: [{ n: 1 }, { n: 2 }],
    });
    expect(Object.keys(answer).at(-1)).toBe('rows');
  });

  it('keeps whole rows only, and says how many were left out', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      i,
      s: 'x'.repeat(100),
    }));
    const answer = fitAnswer(['i', 's'], rows, true, 5, 10_000) as {
      rows: unknown[];
      rows_shown: number;
      row_count: number;
      more_rows: boolean;
      note: string;
    };
    // Measured as Hermes does: the JSON escaped once more as a string.
    expect(JSON.stringify(JSON.stringify(answer)).length).toBeLessThanOrEqual(
      10_000,
    );
    expect(answer.row_count).toBe(500);
    expect(answer.more_rows).toBe(true);
    expect(answer.rows_shown).toBe(answer.rows.length);
    expect(answer.rows.length).toBeGreaterThan(50);
    expect(answer.rows.length).toBeLessThan(500);
    expect(answer.note).toMatch(/Only the first \d+ of 500 rows fit/);
  });
});

describe('sqlErrorMessage', () => {
  const pgError = (code: string, message: string, hint?: string) => ({
    severity: 'ERROR',
    code,
    message,
    hint,
  });

  it('turns a statement timeout into advice', () => {
    expect(sqlErrorMessage(pgError('57014', 'canceling'))).toMatch(
      /ran too long and was stopped/,
    );
  });

  it('says a write or a row lock is refused', () => {
    expect(sqlErrorMessage(pgError('25006', 'read-only'))).toMatch(
      /can only read/,
    );
  });

  it('passes a Postgres error about the query on, with how to look things up', () => {
    expect(
      sqlErrorMessage(pgError('42P01', 'relation "pulls" does not exist')),
    ).toBe(
      'Postgres: relation "pulls" does not exist. To list tables: SELECT table_name FROM information_schema.tables WHERE table_schema = \'public\'.',
    );
    expect(
      sqlErrorMessage(
        pgError(
          '42703',
          'column "amt" does not exist',
          'Perhaps you meant to reference the column "amount".',
        ),
      ),
    ).toMatch(/Hint: Perhaps you meant .*information_schema\.columns/);
  });

  it('keeps errors the query itself causes with the query', () => {
    expect(
      sqlErrorMessage(pgError('08P01', 'bind message supplies 1 parameters')),
    ).toMatch(/^Postgres: bind message/);
    expect(
      sqlErrorMessage(pgError('XX000', 'invalid memory alloc request size')),
    ).toMatch(/^Postgres: invalid memory alloc/);
  });

  it('leaves the database failing, not the query, to the caller', () => {
    // A socket error's code has a SQLSTATE's shape but no severity.
    expect(sqlErrorMessage({ code: 'EPIPE', message: 'write EPIPE' })).toBe(
      null,
    );
    expect(sqlErrorMessage(new Error('connect ECONNREFUSED'))).toBeNull();
    expect(sqlErrorMessage(null)).toBeNull();
    for (const code of ['57P01', '08006', '53300', '58030']) {
      expect(
        sqlErrorMessage({ ...pgError(code, 'down'), severity: 'FATAL' }),
      ).toBeNull();
    }
  });
});

describe('sqlForLog', () => {
  it('masks every value a bot filtered on', () => {
    expect(
      sqlForLog(
        "SELECT *  FROM customer\n WHERE email = 'ace@x.com' OR phone = '+60123456789' OR id = 5550001234 OR note = $$it's$$",
      ),
    ).toBe(
      "SELECT * FROM customer WHERE email = '…' OR phone = '…' OR id = # OR note = '…'",
    );
  });

  it('is not thrown off by apostrophes in comments, names or E strings', () => {
    expect(
      sqlForLog(
        "SELECT * FROM customer -- the player's row\nWHERE email = 'ace@example.com'",
      ),
    ).toBe("SELECT * FROM customer WHERE email = '…'");
    expect(
      sqlForLog(
        'SELECT 1 AS "o\'brien" /* don\'t */ WHERE note = E\'it\\\'s\' AND email = \'ace@example.com\'',
      ),
    ).toBe('SELECT 1 AS "…" WHERE note = E\'…\' AND email = \'…\'');
    // An unpaired quote still never shows an email or a number.
    expect(sqlForLog("WHERE a = 'x AND email = ace@example.com AND n = 5550001234")).toBe(
      "WHERE a = 'x AND email = …@… AND n = #",
    );
  });

  it('keeps a log line short', () => {
    expect(sqlForLog(`SELECT ${'a, '.repeat(400)}1`).length).toBe(500);
  });
});
