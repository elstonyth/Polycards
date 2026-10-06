import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// The desk bots' read-only SQL (GET /reports/admin/sql): any desk key runs
// one query, read-only, capped in rows and time, with the password and token
// tables refused and secret fields hidden.
const STORE_KEY = 's'.repeat(48);
process.env.REPORT_KEY_STORE = STORE_KEY;
process.env.DESK_REPORTS_RATE_BURST_LIMIT = '1000';
process.env.DESK_REPORTS_RATE_LIMIT = '6000';
// Short, so the time-limit test does not wait the real 20 seconds.
process.env.DESK_SQL_TIMEOUT_MS = '1500';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const query = (sql: string, key: string | null = STORE_KEY) =>
      unwrapResponse(
        api.get(`/reports/admin/sql?sql=${encodeURIComponent(sql)}`, {
          headers: key ? { 'x-report-key': key } : {},
        }),
      );
    const customers = () => getContainer().resolve(Modules.CUSTOMER);
    const customerCount = async (): Promise<number> =>
      (await query('SELECT count(*)::int AS n FROM customer')).data.data.rows[0]
        .n;

    describe('GET /reports/admin/sql', () => {
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
          truncated: false,
          data: {
            columns: ['email', 'first_name'],
            rows: [{ email: 'sql-bot@test.dev', first_name: 'Ace' }],
            row_count: 1,
            more_rows: false,
          },
        });
      });

      it('runs read-only, time-limited, on a connection of its own', async () => {
        const res = await query(
          "SELECT current_setting('transaction_read_only') AS read_only, current_setting('statement_timeout') AS time_limit, current_setting('application_name') AS app",
        );
        expect(res.data.data.rows).toEqual([
          { read_only: 'on', time_limit: '1500ms', app: 'desk-bots-sql' },
        ]);
      });

      it('caps the rows at 500 and says there were more', async () => {
        const res = await query('SELECT g FROM generate_series(1, 600) AS g');
        expect(res.data.data.row_count).toBe(500);
        expect(res.data.data.rows).toHaveLength(500);
        expect(res.data.data.more_rows).toBe(true);
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
          const res = await query(sql);
          expect(res.status).toBe(400);
        }
        expect(await customerCount()).toBe(before);
      });

      it('refuses what reaches beyond reading, before anything runs', async () => {
        for (const [sql, why] of [
          ['SELECT pg_terminate_backend(pg_backend_pid())', /not available/],
          ['SELECT * FROM provider_identity', /not open to the desk bots/],
          [
            "SELECT metadata->'partner_credential' FROM customer",
            /Passwords stay hidden/,
          ],
        ] as const) {
          const res = await query(sql);
          expect(res.status).toBe(400);
          expect(res.data.message).toMatch(why);
        }
      });

      it('hides secret fields in rows and shows bank numbers whole', async () => {
        await customers().createCustomers({
          email: 'partner@test.dev',
          metadata: {
            partner_credential: { password: 'Sup3r-secret-pw' },
            bank_accounts: [
              { bankName: 'Maybank', accountNumber: '5550 0012 3456' },
            ],
          },
        });
        const res = await query(
          "SELECT metadata FROM customer WHERE email = 'partner@test.dev'",
        );
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.data)).not.toContain('Sup3r-secret-pw');
        expect(res.data.data.rows[0].metadata).toEqual({
          partner_credential: '[hidden]',
          bank_accounts: [
            { bankName: 'Maybank', accountNumber: '5550 0012 3456' },
          ],
        });
      });

      it('stops a query that runs too long', async () => {
        const res = await query(
          'SELECT count(*) FROM generate_series(1, 100000) a, generate_series(1, 100000) b',
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/ran too long and was stopped/);
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
