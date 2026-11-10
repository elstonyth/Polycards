import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { ASSISTANT_REPORT_KEY } from '../../src/api/admin/assistant/bridge';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// The admin assistant's read-only SQL (POST /reports/admin/sql, its db_query):
// one query, read-only, bounded in time, rows and bytes, with the password and
// token tables refused and every secret hidden, however the query shapes its
// answer. Only the assistant's in-process key opens it; a desk bot's key is
// refused (owner, 2026-11-10).
const STORE_KEY = 's'.repeat(48);
process.env.REPORT_KEY_STORE = STORE_KEY;
process.env.DESK_REPORTS_RATE_BURST_LIMIT = '1000';
process.env.DESK_REPORTS_RATE_LIMIT = '6000';
// Short, so the time-limit tests do not wait the real 20 seconds.
process.env.DESK_SQL_TIMEOUT_MS = '1500';

const PASSWORD = 'Sup3r-secret-pw';
const REAL_NAME = 'Tan Ah Kow bin Ali';
// Shorter than the value mask's 6-character floor.
const SHORT_NAME = 'Ooi';
// Only the audit's key mask stands between this and a reader: it is no
// partner login, so the value scrub does not know it.
const AUDIT_PASSWORD = 'Audit-pw-9Q';
// A query can hand back a secret in a shape no value mask recognizes and
// undo it at home (security audit 2026-11-07): these undo the two shapes.
const reversed = (s: string) => [...s].reverse().join('');
const fromBase64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
const SLOW =
  'SELECT count(*) FROM generate_series(1, 100000) a, generate_series(1, 100000) b';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const query = (sql: unknown, key: string | null = ASSISTANT_REPORT_KEY) =>
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
        for (const [sql, undo] of [
          [
            `SELECT reverse(metadata::text) AS m FROM customer ${where}`,
            reversed,
          ],
          [`SELECT reverse(c::text) AS m FROM customer c ${where}`, reversed],
          [
            `SELECT encode(convert_to(metadata::text, 'UTF8'), 'base64') AS m FROM customer ${where}`,
            fromBase64,
          ],
        ] as const) {
          const res = await query(sql);
          expect(res.status).toBe(200);
          expect(undo(String(res.data.rows[0].m))).not.toContain(PASSWORD);
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
        const [customer, short] = await customers().createCustomers([
          { email: 'named@test.dev' },
          { email: 'short-name@test.dev' },
        ]);
        const packs = getContainer().resolve(PACKS_MODULE) as unknown as {
          createCustomerAccountStates(
            data: { customer_id: string; real_name: string }[],
          ): Promise<unknown>;
          createAdminActionAudits(
            data: {
              admin_id: string;
              entity_type: 'customer';
              entity_id: string;
              action: 'set_real_name' | 'edit';
              before: Record<string, unknown>;
              after: Record<string, unknown>;
              reason: string;
            }[],
          ): Promise<unknown>;
        };
        await packs.createCustomerAccountStates([
          { customer_id: customer.id, real_name: REAL_NAME },
          { customer_id: short.id, real_name: SHORT_NAME },
        ]);
        await packs.createAdminActionAudits([
          {
            admin_id: 'desk-sql-test',
            entity_type: 'customer',
            entity_id: customer.id,
            action: 'set_real_name',
            before: { real_name: null },
            after: { real_name: REAL_NAME },
            reason: 'real name check',
          },
          {
            admin_id: 'desk-sql-test',
            entity_type: 'customer',
            entity_id: short.id,
            action: 'edit',
            before: { note: 'kept' },
            after: { note: 'kept', login: { password: AUDIT_PASSWORD } },
            reason: 'password key check',
          },
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
        for (const [sql, undo] of [
          [
            `SELECT reverse(s::text) AS m FROM customer_account_state s ${where}`,
            reversed,
          ],
          [
            `SELECT encode(convert_to(s::text, 'UTF8'), 'base64') AS m FROM customer_account_state s ${where}`,
            fromBase64,
          ],
          [
            `SELECT reverse(a.after::text) AS m FROM admin_action_audit a WHERE a.entity_id = '${customer.id}'`,
            reversed,
          ],
        ] as const) {
          const res = await query(sql);
          expect(res.status).toBe(200);
          expect(undo(String(res.data.rows[0].m))).not.toContain(REAL_NAME);
        }
        const shortRow = await query(
          `SELECT s::text AS row FROM customer_account_state s WHERE s.customer_id = '${short.id}'`,
        );
        expect(shortRow.data.rows[0].row).not.toContain(SHORT_NAME);
        // A key built from pieces passes the name check; the view still hides
        // the value, and keeps whether one is set.
        const built = await query(
          `SELECT to_jsonb(s) ->> ('real_' || 'name') AS n FROM customer_account_state s WHERE s.customer_id = '${short.id}'`,
        );
        expect(built.data.rows).toEqual([{ n: '[hidden]' }]);
        // A password key in the audit is hidden at the source too, and the
        // masked JSON stays valid.
        const audit = await query(
          `SELECT reverse(a.after::text) AS m FROM admin_action_audit a WHERE a.entity_id = '${short.id}'`,
        );
        expect(audit.status).toBe(200);
        const after = JSON.parse(reversed(String(audit.data.rows[0].m)));
        expect(after).toEqual({ note: 'kept', login: { password: '[hidden]' } });
        expect(JSON.stringify(audit.data)).not.toContain(reversed(AUDIT_PASSWORD));
        expect(
          (await query(`SELECT real_name AS n FROM customer_account_state`))
            .data.message,
        ).toMatch(/real names stay hidden/);
      });

      // The owner, 2026-10-30. The audit rows and group metadata stay open, so
      // the odds in them have to hide whatever shape the query gives them.
      it('never lets coin flip odds or an odds set out', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.saveCoinFlipSettings({
          settings: {
            enabled: true,
            win_percent: 41.25,
            win_percent_2: 32.75,
            published_win_percent: 50,
          },
          revision: (await packs.coinFlipSettings()).revision,
          adminId: 'user_desk_check',
          reason: 'desk bot check',
        });
        await customers().createCustomerGroups({
          name: 'Odds check',
          metadata: { odds_set: 2 },
        });
        const audit = `FROM admin_action_audit a WHERE entity_type LIKE 'coin_flip%'`;
        for (const sql of [
          `SELECT before, after ${audit}`,
          `SELECT after::text AS t ${audit}`,
          `SELECT left(after::text, 60) AS t ${audit}`,
          `SELECT a::text AS t ${audit}`,
          `SELECT to_jsonb(a) AS t ${audit}`,
          `SELECT array_agg(after)::text AS t ${audit}`,
          `SELECT ROW(a)::text AS t ${audit}`,
          `SELECT to_json(after::text)::text AS t ${audit}`,
        ]) {
          const res = await query(sql);
          expect(res.status).toBe(200);
          expect(res.data.row_count).toBe(1);
          expect(JSON.stringify(res.data)).not.toMatch(/41\.25|32\.75/);
        }
        const published = await query(`SELECT after ${audit}`);
        expect(published.data.rows[0].after.published_win_percent).toBe(50);

        const group = `FROM customer_group g WHERE name = 'Odds check'`;
        for (const sql of [
          `SELECT metadata ${group}`,
          `SELECT metadata::text AS t ${group}`,
          `SELECT g::text AS t ${group}`,
          `SELECT array_agg(metadata)::text AS t ${group}`,
        ]) {
          const res = await query(sql);
          expect(res.status).toBe(200);
          expect(res.data.row_count).toBe(1);
          expect(JSON.stringify(res.data)).toContain('[hidden]');
          expect(JSON.stringify(res.data)).not.toMatch(/odds_set[^,}]*2/);
        }

        for (const sql of [
          'SELECT * FROM coin_flip_config',
          'SELECT roll FROM coin_flip_round',
          `SELECT after->>'win_percent' AS n ${audit}`,
          `SELECT metadata->>'odds_set' AS n ${group}`,
        ]) {
          const res = await query(sql);
          expect(res.status).toBe(400);
          expect(res.data.message).toMatch(/actual odds/);
        }
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
        const res = await query("SELECT (SELECT string_agg('x', '') FROM generate_series(1, 100000))::int AS n");
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
        const wide = await query("SELECT (SELECT string_agg('x', '') FROM generate_series(1, 20000)) AS big");
        expect(wide.status).toBe(400);
        expect(wide.data.message).toMatch(/over 16 KB each/);
        const total = await query(
          "SELECT (SELECT string_agg('x', '') FROM generate_series(1, 3000)) AS s FROM generate_series(1, 400)",
        );
        expect(total.status).toBe(400);
        expect(total.data.message).toMatch(/MB, too big to send/);
      });

      it('cuts a long answer at whole rows and says so', async () => {
        const res = await query(
          "SELECT g, (SELECT string_agg('y', '') FROM generate_series(1, 200)) AS s FROM generate_series(1, 400) AS g",
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

      it("needs the assistant's key: none is 401, a desk bot's is refused", async () => {
        expect((await query('SELECT 1', null)).status).toBe(401);
        const desk = await query('SELECT 1', STORE_KEY);
        expect(desk.status).toBe(403);
        expect(desk.data.message).toMatch(/only available in the admin assistant/);
      });
    });

    // Owner, 2026-10-30: the bots never read coin flip's actual odds or a
    // group's odds set. The rows carrying them stay open, so this is run against
    // queries that reshape those rows, where hiding by name cannot help.
    describe('coin flip odds and odds sets', () => {
      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      // Odd figures, so a match in an answer can only be one of these.
      const ODDS = /12\.34|43\.21|56\.78|21\.43|34\.12|87\.65/;
      const SET = 7;
      // LIKE: naming coin_flip_config is itself refused, and this is the filter
      // the refusal tells a bot to use.
      const AUDIT = "admin_action_audit a WHERE a.entity_type LIKE 'coin%'";

      const seed = async () => {
        // Twice, so the second row's `before` holds real odds as well.
        for (const [win_percent, win_percent_2, win_percent_3, reason] of [
          [12.34, 43.21, 56.78, 'first odds'],
          [21.43, 34.12, 87.65, 'set the odds'],
        ] as const) {
          await packs().saveCoinFlipSettings({
            settings: {
              enabled: false,
              win_percent,
              win_percent_2,
              win_percent_3,
              published_win_percent: 50,
            },
            revision: (await packs().coinFlipSettings()).revision,
            adminId: 'desk-sql-test',
            reason,
          });
        }
        await customers().createCustomerGroups({
          name: 'Set seven',
          metadata: { odds_set: SET, note: 'kept' },
        });
        await packs().createAdminActionAudits([
          {
            admin_id: 'desk-sql-test',
            entity_type: 'customer',
            entity_id: 'cus_1',
            action: 'set_player_group',
            reason: 'moved',
            after: { group: { id: 'g1', name: 'Set seven', odds_set: SET } },
          },
        ]);
      };

      it.each([
        // The key comes back as a value, so hiding by key cannot see it.
        [
          'key and value',
          `SELECT e.key, e.value FROM ${AUDIT.replace(' WHERE', ', jsonb_each(a.after) e WHERE')}`,
        ],
        [
          'the old values',
          `SELECT e.key, e.value FROM ${AUDIT.replace(' WHERE', ', jsonb_each(a.before) e WHERE')}`,
        ],
        [
          'a key built from pieces',
          `SELECT a.after->>('win_'||'percent') AS p FROM ${AUDIT}`,
        ],
        [
          'a JSON path',
          `SELECT jsonb_path_query(a.after, '$.*') AS v FROM ${AUDIT}`,
        ],
        [
          'text reshaped past the mask',
          `SELECT replace(a.after::text, 'win', 'w1n') AS m FROM ${AUDIT}`,
        ],
        [
          'a whole row walked',
          `SELECT e.key, e.value FROM ${AUDIT.replace(' WHERE', ", jsonb_each(to_jsonb(a)->'after') e WHERE")}`,
        ],
      ])('keeps the actual odds out of the audit: %s', async (_how, sql) => {
        await seed();
        const res = await query(sql);
        expect(res.status).toBe(200);
        expect(res.data.row_count).toBeGreaterThan(0);
        expect(JSON.stringify(res.data.rows)).not.toMatch(ODDS);
      });

      it.each([
        [
          'key and value',
          "SELECT e.key, e.value FROM customer_group g, jsonb_each(g.metadata) e WHERE g.name = 'Set seven'",
        ],
        [
          'a key built from pieces',
          "SELECT g.metadata->>('odds'||'_set') AS s FROM customer_group g WHERE g.name = 'Set seven'",
        ],
        [
          'a JSON path',
          "SELECT jsonb_path_query(g.metadata, '$.*') AS v FROM customer_group g WHERE g.name = 'Set seven'",
        ],
        [
          'text reshaped past the mask',
          "SELECT replace(g.metadata::text, 'odds', 'o-d-d-s') AS m FROM customer_group g WHERE g.name = 'Set seven'",
        ],
        [
          'a nested audit copy',
          "SELECT e.key, e.value FROM admin_action_audit a, jsonb_each(a.after->'group') e WHERE a.action = 'set_player_group'",
        ],
      ])("keeps a group's odds set hidden: %s", async (_how, sql) => {
        await seed();
        const res = await query(sql);
        expect(res.status).toBe(200);
        expect(res.data.row_count).toBeGreaterThan(0);
        // A set number on its own, or beside its key in reshaped text.
        expect(JSON.stringify(res.data.rows)).not.toMatch(
          /(?<![\d.])7(?![\d.])/,
        );
      });

      it('answers nothing to a question about a hidden value', async () => {
        await seed();
        const set = await query(
          `SELECT count(*)::int AS n FROM customer_group g WHERE g.metadata->>('odds'||'_set') = '${SET}'`,
        );
        expect(set.data.rows).toEqual([{ n: 0 }]);
        const odds = await query(
          `SELECT count(*)::int AS n FROM ${AUDIT} AND a.after->>('win_'||'percent') = '12.34'`,
        );
        expect(odds.data.rows).toEqual([{ n: 0 }]);
      });

      it.each([
        'SELECT * FROM public.customer_group',
        'SELECT * FROM "public"."admin_action_audit"',
        'SELECT * FROM public./* x */customer_group',
      ])('refuses the table behind the mask: %s', async (sql) => {
        await seed();
        const res = await query(sql);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/odds sets stay hidden/);
      });

      it('masks every masked table for every query, even one naming none', async () => {
        const views = await query(
          'SELECT relname FROM pg_class WHERE relnamespace = pg_my_temp_schema() ORDER BY relname',
        );
        expect(views.data.rows).toEqual([
          { relname: 'admin_action_audit' },
          { relname: 'customer' },
          { relname: 'customer_account_state' },
          { relname: 'customer_group' },
        ]);
        // It is the view a named table resolves to, however it is spelled.
        const res = await query(
          `SELECT c.relkind FROM pg_class c WHERE c.oid = 'CUSTOMER_GROUP'::regclass`,
        );
        expect(res.data.rows).toEqual([{ relkind: 'v' }]);
      });

      it('keeps everything else in those rows open, and stays read-only', async () => {
        await seed();
        const audit = await query(
          `SELECT a.admin_id, a.action, a.reason, a.after->>'published_win_percent' AS published, a.after->'enabled' AS enabled FROM ${AUDIT} ORDER BY a.after->'revision' DESC LIMIT 1`,
        );
        expect(audit.status).toBe(200);
        expect(audit.data.rows).toEqual([
          {
            admin_id: 'desk-sql-test',
            action: 'edit',
            reason: 'set the odds',
            published: '50',
            enabled: false,
          },
        ]);
        const group = await query(
          "SELECT g.id IS NOT NULL AS has_id, g.name, g.metadata->>'note' AS note FROM customer_group g WHERE g.name = 'Set seven'",
        );
        expect(group.data.rows).toEqual([
          { has_id: true, name: 'Set seven', note: 'kept' },
        ]);
        const write = await query('SELECT 1 FROM customer_group FOR UPDATE');
        expect(write.status).toBe(400);
        const readOnly = await query(
          "SELECT current_setting('transaction_read_only') AS ro",
        );
        expect(readOnly.data.rows).toEqual([{ ro: 'on' }]);
      });
    });
  },
});
