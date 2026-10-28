import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GET /admin/stats/leaders: per window, who topped up the most, made the
// biggest single top-up, withdrew the most and drew the most packs. The custom
// range 2026-09-10..2026-09-11 (MYT) is [2026-09-09T16:00Z, 2026-09-11T16:00Z).

const FROM_EDGE = '2026-09-09T16:00:00.000Z';
const TO_EDGE = '2026-09-11T16:00:00.000Z'; // exclusive
const IN = '2026-09-10T02:00:00.000Z';
const LATER = '2026-09-10T09:00:00.000Z';
const RANGE = '?range=custom&from=2026-09-10&to=2026-09-11';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin stats leaders', () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'leaders-admin@test.dev',
          'leaders-test-password-1',
        );
      });

      const leaders = (query: string, auth = true) =>
        unwrapResponse(
          api.get(`/admin/stats/leaders${query}`, {
            headers: auth ? { authorization: `Bearer ${adminToken}` } : {},
          }),
        );

      const packs = () => getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      const deposit = (customer_id: string, amount: number, at: string, i: string, status: 'settled' | 'pending' = 'settled') =>
        packs().createGatewayDeposits([
          {
            merchant_transaction_id: `leaders-mt-${i}`,
            customer_id,
            amount_requested: amount,
            amount_settled: status === 'settled' ? amount : null,
            payment_method_code: 'BQR',
            status,
            settled_at: status === 'settled' ? new Date(at) : null,
          },
        ]);

      const payout = (customer_id: string, amount: number, at: string, i: string, status: 'settled' | 'pending' = 'settled') =>
        packs().createGatewayWithdrawals([
          {
            merchant_transaction_id: `leaders-wd-${i}`,
            customer_id,
            amount,
            amount_settled: status === 'settled' ? amount : null,
            bank_code: 'MBB',
            account_number: '000000000000',
            account_holder_name: 'Leaders Test',
            status,
            settled_at: new Date(at),
          },
        ]);

      const pulls = (
        customer_id: string,
        n: number,
        source: 'pack' | 'bonus' | 'gift' | 'free' | 'reward',
        at = IN,
      ) =>
        packs().createPulls(
          Array.from({ length: n }, () => ({
            customer_id,
            pack_id: 'leaders-pack',
            card_id: 'leaders-card',
            rolled_at: new Date(at),
            source,
          })),
        );

      it('refuses a read without an admin, and a bad range', async () => {
        expect((await leaders('', false)).status).toBe(401);
        expect((await leaders('?range=forever')).status).toBe(400);
        expect((await leaders(`${RANGE}&scope=partners`)).status).toBe(400);
      });

      it('names nobody in a window nobody played in', async () => {
        const res = await leaders('?range=today');
        expect(res.status).toBe(200);
        expect(res.data.leaders).toEqual({
          topped_up: null,
          biggest_topup: null,
          withdrawn: null,
          draws: null,
        });
      });

      it('picks the top player for each of the four, inside the window only', async () => {
        const customers = getContainer().resolve(Modules.CUSTOMER);
        const named = await customers.createCustomers({
          email: 'leaders-named@test.dev',
          first_name: 'Ada',
          last_name: 'Lim',
          has_account: true,
        });

        // Top-ups: X 30 + 30 = 60 is the most; Y's single 50 is the biggest
        // one, and W's 50 later the same day loses that tie by time. Z's 500
        // settles on the exclusive end and P's 900 never settled.
        await deposit('cus_x', 30, IN, '1');
        await deposit('cus_x', 30, LATER, '2');
        await deposit('cus_y', 50, FROM_EDGE, '3');
        await deposit('cus_w', 50, LATER, '4');
        await deposit('cus_z', 500, TO_EDGE, '5');
        await deposit('cus_p', 900, IN, '6', 'pending');

        // Withdrawals: Y 80 + 30 = 110 beats the named player's 100. X's 500
        // payout is still pending, so it is not money out yet.
        await payout('cus_y', 80, IN, '1');
        await payout('cus_y', 30, LATER, '2');
        await payout(named.id, 100, IN, '3');
        await payout('cus_x', 500, IN, '4', 'pending');

        // Draws are paid pack opens: the named player's 2 + 2 bonus-funded
        // beat X's 3. Z's gifts, free and reward packs count for nothing, or
        // Z would lead with 7; Q's 9 are outside the window.
        await pulls(named.id, 2, 'pack');
        await pulls(named.id, 2, 'bonus');
        await pulls('cus_x', 3, 'pack');
        await pulls('cus_z', 1, 'pack');
        await pulls('cus_z', 4, 'gift');
        await pulls('cus_z', 1, 'free');
        await pulls('cus_z', 1, 'reward');
        await pulls('cus_q', 9, 'pack', TO_EDGE);

        const res = await leaders(RANGE);
        expect(res.status).toBe(200);
        expect(res.data.from).toBe(FROM_EDGE);
        expect(res.data.to).toBe(TO_EDGE);
        expect(res.data.leaders).toEqual({
          topped_up: {
            customer_id: 'cus_x',
            name: null,
            email: null,
            amount: 60,
            count: 2,
          },
          biggest_topup: {
            customer_id: 'cus_y',
            name: null,
            email: null,
            amount: 50,
            count: 1,
          },
          withdrawn: {
            customer_id: 'cus_y',
            name: null,
            email: null,
            amount: 110,
            count: 2,
          },
          draws: {
            customer_id: named.id,
            name: 'Ada Lim',
            email: 'leaders-named@test.dev',
            amount: null,
            count: 4,
          },
        });
      });

      // Real customers (spec 2026-10-14-admin-finance-pages §3): a member of
      // a non-default group leads for everyone but never for real customers.
      it('scope=default never names a customer outside the real customers', async () => {
        const customers = getContainer().resolve(Modules.CUSTOMER);
        const [real, grouped] = await customers.createCustomers([
          { email: 'leaders-real@test.dev', has_account: true },
          { email: 'leaders-grouped@test.dev', has_account: true },
        ]);
        const partner = await customers.createCustomerGroups({
          name: 'Leaders Partners',
        });
        await customers.addCustomerToGroup([
          { customer_id: grouped.id, customer_group_id: partner.id },
        ]);
        await deposit(real.id, 10, IN, 's1');
        await deposit(grouped.id, 1000, IN, 's2');
        await payout(real.id, 5, IN, 's1');
        await payout(grouped.id, 500, IN, 's2');
        await pulls(real.id, 1, 'pack');
        await pulls(grouped.id, 5, 'pack');

        const everyone = (await leaders(`${RANGE}&scope=all`)).data.leaders;
        const realOnly = (await leaders(`${RANGE}&scope=default`)).data
          .leaders;
        for (const k of [
          'topped_up',
          'biggest_topup',
          'withdrawn',
          'draws',
        ] as const) {
          expect(everyone[k].customer_id).toBe(grouped.id);
          expect(realOnly[k].customer_id).toBe(real.id);
        }
      });
    });
  },
});
