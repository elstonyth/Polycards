import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// The desk bots' read-only SQL (POST /reports/admin/sql): any desk key runs
// one query, read-only, bounded in time, rows and bytes, with the password
// and token tables refused and every secret hidden, however the query shapes
// its answer.
const STORE_KEY = 's'.repeat(48);
process.env.REPORT_KEY_STORE = STORE_KEY;
process.env.DESK_REPORTS_RATE_BURST_LIMIT = '1000';
process.env.DESK_REPORTS_RATE_LIMIT = '6000';
// Short, so the time-limit tests do not wait the real 20 seconds.
process.env.DESK_SQL_TIMEOUT_MS = '1500';

const PASSWORD = 'Sup3r-secret-pw';
const REAL_NAME = 'Tan Ah Kow bin Ali';
const SLOW =
  'SELECT count(*) FROM generate_series(1, 100000) a, generate_series(1, 100000) b';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const query = (sql: unknown, key: string | null = STORE_KEY) =>
      unwrapResponse(
        api.post('/reports/admin/sql', sql === undefined ? {} : { sql }, {
          headers: key ? { 'x-report-key': key } : {},
        }),
      );
    const customers = () => getContainer().resolve(Modules.CUSTOMER);
    type Raw = {
      raw(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
    };
    const sharedDb = () =>
      getContainer().resolve(
        ContainerRegistrationKeys.PG_CONNECTION,
      ) as unknown as Raw;
    const customerCount = async (): Promise<number> =>
      (await query('SELECT count(*)::int AS n FROM customer')).data.rows[0].n;

    describe('POST /reports/admin/sql', () => {
      it('answers a read query with its columns and rows', async () => {
        await customers().createCustomers({
          email: 'sql-bot@test.dev',
          first_name: 'Ace',
        });
        const res = await query(
          "SELECT email, first_name FROM customer WHERE email = 'sql-bot@test.dev'",
        );
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          columns: ['email', 'first_name'],
          row_count: 1,
          more_rows: false,
          rows: [{ email: 'sql-bot@test.dev', first_name: 'Ace' }],
        });
      });

      it('runs read-only and time-limited, on a connection closed afterwards', async () => {
        const res = await query(
          "SELECT current_setting('transaction_read_only') AS read_only, current_setting('statement_timeout') AS time_limit, current_setting('application_name') AS app, pg_backend_pid() AS pid",
        );
        const [row] = res.data.rows;
        expect(row).toMatchObject({
          read_only: 'on',
          time_limit: '1500ms',
          app: 'desk-bots-sql',
        });
        // Not one of the site's pooled connections, which stay open: the
        // query's own connection is gone once it has answered.
        let open = 1;
        for (let i = 0; i < 20 && open > 0; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          const { rows } = await sharedDb().raw(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ${Number(row.pid)}`,
          );
          open = rows[0].n as number;
        }
        expect(open).toBe(0);
      });

      it('caps the rows at 500 and says there were more', async () => {
        const res = await query('SELECT g FROM generate_series(1, 600) AS g');
        expect(res.data.row_count).toBe(500);
        expect(res.data.rows).toHaveLength(500);
        expect(res.data.more_rows).toBe(true);
      });

      it('changes nothing, however the query is written', async () => {
        await customers().createCustomers({ email: 'keep@test.dev' });
        const before = await customerCount();
        expect(before).toBeGreaterThan(0);
        for (const sql of [
          'DELETE FROM customer',
          'WITH gone AS (DELETE FROM customer RETURNING id) SELECT * FROM gone',
          // Out of the subquery and on to a second command.
          'SELECT 1) AS a; DELETE FROM customer; SELECT * FROM (SELECT 1',
          "SELECT * FROM customer; UPDATE customer SET email = 'x'",
        ]) {
          expect((await query(sql)).status).toBe(400);
        }
        // Row locks are refused by the READ ONLY transaction itself.
        const locked = await query('SELECT id FROM customer FOR UPDATE');
        expect(locked.status).toBe(400);
        expect(locked.data.message).toMatch(/can only read/);
        expect(await customerCount()).toBe(before);
      });

      it('refuses what reaches beyond reading, before anything runs', async () => {
        for (const [sql, why] of [
          ['SELECT pg_terminate_backend(pg_backend_pid())', /not available/],
          ['SELECT query FROM pg_stat_activity', /not available/],
          ['SELECT * FROM provider_identity', /not open to the desk bots/],
          [
            'SELECT * FROM auth_verification_token',
            /not open to the desk bots/,
          ],
          [
            "SELECT metadata->'partner_credential' FROM customer",
            /Passwords stay hidden/,
          ],
        ] as const) {
          const res = await query(sql);
          expect(res.status).toBe(400);
          expect(res.data.message).toMatch(why);
        }
        expect((await query(undefined)).status).toBe(400);
      });

      it('never lets a stored password out, whatever shape the query gives it', async () => {
        await customers().createCustomers({
          email: 'partner@test.dev',
          metadata: {
            handle: 'partner-ace',
            partner_credential: { password: PASSWORD, issued_at: 'x' },
            bank_accounts: [
              { bankName: 'Maybank', accountNumber: '5550 0012 3456' },
            ],
          },
        });
        const where = "WHERE email = 'partner@test.dev'";
        for (const sql of [
          `SELECT metadata FROM customer ${where}`,
          `SELECT metadata::text AS m FROM customer ${where}`,
          `SELECT jsonb_pretty(metadata) AS m FROM customer ${where}`,
          `SELECT key, value FROM customer, jsonb_each_text(metadata) ${where}`,
          `SELECT row_to_json(c)::text AS r FROM customer c ${where}`,
          `SELECT 'x' || metadata::text AS m FROM customer ${where}`,
          `SELECT jsonb_path_query(metadata, 'strict $.**') AS v FROM customer ${where}`,
        ]) {
          const res = await query(sql);
          expect(res.status).toBe(200);
          expect(JSON.stringify(res.data)).not.toContain(PASSWORD);
        }
        const whole = await query(`SELECT metadata FROM customer ${where}`);
        expect(whole.data.rows[0].metadata).toEqual({
          handle: 'partner-ace',
          partner_credential: '[hidden]',
          bank_accounts: [
            { bankName: 'Maybank', accountNumber: '5550 0012 3456' },
          ],
        });
        // Postgres repeats a bad cast's input in its error: masked there too.
        const echoed = await query(
          `SELECT (metadata::text)::int FROM customer ${where}`,
        );
        expect(echoed.status).toBe(400);
        expect(echoed.data.message).toMatch(/invalid input syntax/);
        expect(echoed.data.message).toContain('[hidden]');
        expect(echoed.data.message).not.toContain(PASSWORD);
      });

      it('never lets a real name out either, even in a whole row cast to text', async () => {
        const customer = await customers().createCustomers({
          email: 'named@test.dev',
        });
        const packs = getContainer().resolve(PACKS_MODULE) as unknown as {
          createCustomerAccountStates(
            data: { customer_id: string; real_name: string }[],
          ): Promise<unknown>;
        };
        await packs.createCustomerAccountStates([
          { customer_id: customer.id, real_name: REAL_NAME },
        ]);
        const where = `WHERE s.customer_id = '${customer.id}'`;
        for (const sql of [
          `SELECT s.* FROM customer_account_state s ${where}`,
          `SELECT s::text AS row FROM customer_account_state s ${where}`,
          `SELECT key, value FROM customer_account_state s, jsonb_each_text(to_jsonb(s)) ${where}`,
        ]) {
          const res = await query(sql);
          expect(res.status).toBe(200);
          expect(JSON.stringify(res.data)).not.toContain(REAL_NAME);
        }
        expect(
          (await query(`SELECT real_name AS n FROM customer_account_state`))
            .data.message,
        ).toMatch(/real names stay hidden/);
      });

      it('keeps values as Postgres shows them: a Malaysia time stays one', async () => {
        const res = await query(
          "SELECT timestamp '2026-10-07 09:30:00' AS myt, date '2026-10-07' AS day, timestamptz '2026-10-07 01:30:00+00' AS at, 12345.67::numeric AS rm",
        );
        const [row] = res.data.rows;
        expect(row.myt).toBe('2026-10-07T09:30:00');
        expect(row.day).toBe('2026-10-07');
        expect(new Date(row.at).toISOString()).toBe('2026-10-07T01:30:00.000Z');
        expect(row.rm).toBe(12345.67);
      });

      it('keeps a column whose name the wrapper uses for the row', async () => {
        const res = await query(
          'SELECT g AS id, g * 2 AS q, g * 3 AS desk_bot_row FROM generate_series(1, 2) AS g',
        );
        expect(res.data.rows).toEqual([
          { id: 1, q: 2, desk_bot_row: 3 },
          { id: 2, q: 4, desk_bot_row: 6 },
        ]);
      });

      it('cuts a huge error message instead of sending it all', async () => {
        const res = await query("SELECT repeat('x', 100000)::int AS n");
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/invalid input syntax/);
        expect(res.data.message.length).toBeLessThan(2_200);
      });

      it('refuses placeholders, which would bind to its own values', async () => {
        const res = await query('SELECT * FROM pull WHERE customer_id = $2');
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/Placeholders like \$1/);
      });

      it('refuses two columns with one name instead of losing one', async () => {
        const res = await query(
          'SELECT sum(x), sum(y) FROM (VALUES (1, 2)) AS v(x, y)',
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/Two columns are both named sum/);
      });

      it('never holds a big answer: rows and totals are capped in bytes', async () => {
        const wide = await query("SELECT repeat('x', 20000) AS big");
        expect(wide.status).toBe(400);
        expect(wide.data.message).toMatch(/over 16 KB each/);
        const total = await query(
          "SELECT repeat('x', 3000) AS s FROM generate_series(1, 400)",
        );
        expect(total.status).toBe(400);
        expect(total.data.message).toMatch(/MB, too big to send/);
      });

      it('cuts a long answer at whole rows and says so', async () => {
        const res = await query(
          "SELECT g, repeat('y', 200) AS s FROM generate_series(1, 400) AS g",
        );
        expect(res.status).toBe(200);
        expect(res.data.row_count).toBe(400);
        expect(res.data.rows_shown).toBe(res.data.rows.length);
        expect(res.data.rows.length).toBeLessThan(400);
        expect(res.data.note).toMatch(/Only the first \d+ of 400 rows fit/);
        expect(JSON.stringify(res.data).length).toBeLessThan(40_000);
      });

      it('stops a query that runs too long', async () => {
        const res = await query(SLOW);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/ran too long and was stopped/);
      });

      it('takes one query at a time, with two waiting, and turns the rest away', async () => {
        const statuses = (
          await Promise.all([1, 2, 3, 4].map(() => query(SLOW)))
        ).map((r) => r.status);
        expect(statuses.filter((s) => s === 429)).toHaveLength(1);
        expect(statuses.filter((s) => s === 400)).toHaveLength(3);
      });

      it('passes a Postgres error on in plain words', async () => {
        const res = await query('SELECT * FROM pulls');
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(
          /relation "pulls" does not exist.*information_schema\.tables/,
        );
      });

      it('needs a desk key', async () => {
        expect((await query('SELECT 1', null)).status).toBe(401);
      });
    });
  },
});
