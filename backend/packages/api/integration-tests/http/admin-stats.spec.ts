import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GET /admin/stats: sign-ups and top-ups for a window and the window before
// it. Rows are seeded, then aged with a raw UPDATE, because created_at is
// ORM-managed on insert. The custom range pins both windows to fixed past
// days, so the expectations do not depend on when the suite runs.
//
// Custom 2026-09-10..2026-09-11 (MYT) gives:
//   current  [2026-09-09T16:00Z, 2026-09-11T16:00Z)
//   previous [2026-09-07T16:00Z, 2026-09-09T16:00Z)

const FROM_EDGE = '2026-09-09T16:00:00.000Z'; // current start (in) = previous end (out)
const TO_EDGE = '2026-09-11T16:00:00.000Z'; // current end (out)
const IN_CURRENT = '2026-09-10T02:00:00.000Z';
const IN_PREVIOUS = '2026-09-08T03:00:00.000Z';
const BEFORE_BOTH = '2026-09-01T00:00:00.000Z';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin stats', () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'stats-admin@test.dev',
          'stats-test-password-1',
        );
      });

      const stats = (query: string, headers?: Record<string, string>) =>
        unwrapResponse(
          api.get(`/admin/stats${query}`, {
            headers: headers ?? { authorization: `Bearer ${adminToken}` },
          }),
        );

      const setCreatedAt = async (
        table: 'customer' | 'credit_transaction',
        id: string,
        at: string,
      ): Promise<void> => {
        const knex = getContainer().resolve(
          ContainerRegistrationKeys.PG_CONNECTION,
        ) as unknown as {
          raw: (
            sql: string,
            bindings: unknown[],
          ) => Promise<{ rowCount: number }>;
        };
        const res = await knex.raw(
          `UPDATE ${table} SET created_at = ? WHERE id = ?`,
          [at, id],
        );
        // A silent zero-row UPDATE would leave the row at "now", outside every
        // window, and the counts would pass for the wrong reason.
        expect(res.rowCount).toBe(1);
      };

      it('rejects an unauthenticated read with 401', async () => {
        expect((await stats('', {})).status).toBe(401);
      });

      it('answers 400 for a bad range and 200 for the default', async () => {
        expect((await stats('?range=forever')).status).toBe(400);
        expect(
          (await stats('?range=custom&from=2026-09-11&to=2026-09-10')).status,
        ).toBe(400);
        const today = await stats('');
        expect(today.status).toBe(200);
        expect(Date.parse(today.data.current.to)).toBeLessThanOrEqual(
          Date.parse(today.data.as_of),
        );
      });

      it('counts sign-ups and gateway top-ups per window, first top-ups over the whole history', async () => {
        const container = getContainer();
        const customers = container.resolve(Modules.CUSTOMER);
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

        // Sign-ups. Current: A (inside) and B (on the inclusive start).
        // Previous: P. C sits on the exclusive end, so it is in neither
        // window. G is a guest and never counts.
        const seedCustomer = async (
          email: string,
          hasAccount: boolean,
          at: string,
        ) => {
          const c = await customers.createCustomers({
            email,
            has_account: hasAccount,
          });
          await setCreatedAt('customer', c.id, at);
        };
        await seedCustomer('stats-a@test.dev', true, IN_CURRENT);
        await seedCustomer('stats-b@test.dev', true, FROM_EDGE);
        await seedCustomer('stats-c@test.dev', true, TO_EDGE);
        await seedCustomer('stats-g@test.dev', false, IN_CURRENT);
        await seedCustomer('stats-p@test.dev', true, IN_PREVIOUS);

        // An operator-generated partner account inside the window is not a
        // sign-up. Minted through the real generator, so the marker the SQL
        // excludes on is the one the generator actually writes.
        const minted = await unwrapResponse(
          api.post(
            '/admin/players',
            { count: 1 },
            { headers: { authorization: `Bearer ${adminToken}` } },
          ),
        );
        expect(minted.status).toBe(201);
        await setCreatedAt('customer', minted.data.players[0].id, IN_CURRENT);

        // Top-ups come from the payment gateway's settled deposits, by
        // settled_at. X first paid in the previous window, so X's current
        // deposit is not a first. Y's first is 100 and Y's 20 is a repeat.
        // W's first sits on the inclusive start. V's first is before both
        // windows. Z sits on the exclusive end. Q and R never settled.
        const deposits: [
          string,
          number,
          'settled' | 'pending' | 'failed',
          string,
        ][] = [
          ['cus_x', 50, 'settled', IN_PREVIOUS],
          ['cus_x', 30, 'settled', IN_CURRENT],
          ['cus_y', 100, 'settled', IN_CURRENT],
          ['cus_y', 20, 'settled', '2026-09-11T10:00:00.000Z'],
          ['cus_w', 40, 'settled', FROM_EDGE],
          ['cus_v', 10, 'settled', BEFORE_BOTH],
          ['cus_v', 5, 'settled', IN_CURRENT],
          ['cus_z', 70, 'settled', TO_EDGE],
          ['cus_q', 60, 'pending', IN_CURRENT],
          ['cus_r', 80, 'failed', IN_CURRENT],
        ];
        await packs.createGatewayDeposits(
          deposits.map(([customer_id, amount, status, at], i) => ({
            merchant_transaction_id: `stats-mt-${i}`,
            customer_id,
            amount_requested: amount,
            amount_settled: status === 'settled' ? amount : null,
            payment_method_code: 'BQR',
            status,
            settled_at: status === 'settled' ? new Date(at) : null,
          })),
        );

        // Wallet credits the gateway never saw are not top-ups: M has a
        // ledger 'topup' with no deposit behind it, N a manual adjustment.
        const manual = await packs.createCreditTransactions([
          {
            customer_id: 'cus_m',
            amount: 999,
            reason: 'topup' as const,
            pull_id: null,
            reference: null,
          },
          {
            customer_id: 'cus_n',
            amount: 5000,
            reason: 'adjustment' as const,
            pull_id: null,
            reference: 'grant',
          },
        ]);
        for (const row of manual) {
          await setCreatedAt('credit_transaction', row.id, IN_CURRENT);
        }

        const res = await stats('?range=custom&from=2026-09-10&to=2026-09-11');
        expect(res.status).toBe(200);
        expect(res.data.current).toEqual({
          from: FROM_EDGE,
          to: TO_EDGE,
          stats: {
            signups: 2,
            topup_count: 5, // X30, Y100, Y20, W40, V5
            topup_customers: 4, // X, Y, W, V
            topup_amount: 195,
            first_topup_count: 2, // Y100, W40
            first_topup_amount: 140,
          },
        });
        expect(res.data.previous).toEqual({
          from: '2026-09-07T16:00:00.000Z',
          to: FROM_EDGE,
          stats: {
            signups: 1,
            topup_count: 1,
            topup_customers: 1,
            topup_amount: 50,
            first_topup_count: 1,
            first_topup_amount: 50,
          },
        });
      });
    });
  },
});
