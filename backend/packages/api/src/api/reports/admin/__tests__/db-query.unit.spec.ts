import { sqlErrorMessage, sqlRefusal, wrapQuery } from '../db-query';

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
    "SELECT * FROM customer WHERE metadata ? 'handle'",
  ])('runs %p', (sql) => {
    expect(sqlRefusal(sql)).toBeNull();
  });

  it.each([
    [undefined, /sql is required/],
    ['   ', /sql is required/],
    [['SELECT 1'], /sql is required/],
    [`SELECT '${'x'.repeat(20_001)}'`, /too long/],
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
    ["SELECT nextval('seq')", /nextval is not available/],
    ['SELECT lo_import(1)', /lo_import is not available/],
    [
      "SELECT most_common_vals FROM pg_stats WHERE tablename = 'x'",
      /pg_stats is not available/,
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
    ['SELECT * FROM customer FOR UPDATE', /Row locks/],
    ['SELECT * FROM pull FOR NO KEY UPDATE', /Row locks/],
    ['SELECT * FROM pack for share', /Row locks/],
    ['SELECT U&"\\0070g_sleep"(1)', /Unicode-escaped/],
  ])('refuses %p', (sql, why) => {
    expect(sqlRefusal(sql)).toMatch(why);
  });
});

describe('wrapQuery', () => {
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
});

describe('sqlErrorMessage', () => {
  it('turns a statement timeout into advice', () => {
    expect(sqlErrorMessage({ code: '57014', message: 'canceling' })).toMatch(
      /ran too long and was stopped/,
    );
  });

  it('says a write is refused', () => {
    expect(sqlErrorMessage({ code: '25006', message: 'read-only' })).toMatch(
      /can only read/,
    );
  });

  it('passes a Postgres error on, with its hint and how to look things up', () => {
    expect(
      sqlErrorMessage({
        code: '42P01',
        message: 'relation "pulls" does not exist',
      }),
    ).toBe(
      'Postgres: relation "pulls" does not exist. To list tables: SELECT table_name FROM information_schema.tables WHERE table_schema = \'public\'.',
    );
    expect(
      sqlErrorMessage({
        code: '42703',
        message: 'column "amt" does not exist',
        hint: 'Perhaps you meant to reference the column "amount".',
      }),
    ).toMatch(/Hint: Perhaps you meant .*information_schema\.columns/);
  });

  it('leaves a failure that is not a Postgres error to the caller', () => {
    expect(sqlErrorMessage(new Error('connect ECONNREFUSED'))).toBeNull();
    expect(sqlErrorMessage({ code: 'ECONNREFUSED' })).toBeNull();
    expect(sqlErrorMessage(null)).toBeNull();
  });
});
