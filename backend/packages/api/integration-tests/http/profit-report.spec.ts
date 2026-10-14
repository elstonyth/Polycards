import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GET /admin/profit-report (spec 2026-10-14-admin-finance-pages §4): real
// money in and out, what players could still cash out, and activity, for
// real customers (scope=default, the default) or every account (scope=all).
//
// Seeded:
//   real      (no group)            deposits 100 (net 98) + 50 (no net yet),
//                                    payout 60 (net 61), ledger topup 150,
//                                    open −80, buyback +30, one vaulted card
//   grouped   (Profit Partners)     deposit 1000 (net 1000), ledger topup
//                                    1000, bonus_grant 200 (all bonus)
//   generated (POST /admin/players) deposit 70 (net 70)
//   both      (DEFAULT + Profit Partners: the partner group wins, so out)
//                                    deposit 40 (net 40)
// real also has a deposit settled by hand (no amount_settled, no net), and
// payouts of 25 (pending) and 10 (held): debited from the wallet already,
// not yet paid, so still owed.
// No FxRate row → the 4.7 default; the $10 card at the 1.2 default
// multiplier is RM 56.40 display, RM 50.76 at the 90% sell-back.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin profit report', () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'profit-admin@test.dev',
          'profit-test-password-1',
        );
      });

      const report = (query: string, auth = true) =>
        unwrapResponse(
          api.get(`/admin/profit-report${query}`, {
            headers: auth ? { authorization: `Bearer ${adminToken}` } : {},
          }),
        );

      it('rejects an unauthenticated read with 401', async () => {
        expect((await report('', false)).status).toBe(401);
      });

      it('answers 400 for a bad scope or range', async () => {
        expect((await report('?scope=partners')).status).toBe(400);
        expect((await report('?range=forever')).status).toBe(400);
        expect(
          (await report('?range=custom&from=2026-09-11&to=2026-09-10')).status,
        ).toBe(400);
      });

      it('counts real customers by default and everyone with scope=all', async () => {
        const container = getContainer();
        const customers = container.resolve(Modules.CUSTOMER);
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

        const [real, grouped, both] = await customers.createCustomers([
          { email: 'profit-real@test.dev', has_account: true },
          { email: 'profit-grouped@test.dev', has_account: true },
          { email: 'profit-both@test.dev', has_account: true },
        ]);
        const partnerGroup = await customers.createCustomerGroups({
          name: 'Profit Partners',
        });
        const [existingDefault] = await customers.listCustomerGroups({
          name: 'DEFAULT',
        });
        const defaultGroup =
          existingDefault ??
          (await customers.createCustomerGroups({ name: 'DEFAULT' }));
        await customers.addCustomerToGroup([
          { customer_id: grouped.id, customer_group_id: partnerGroup.id },
          { customer_id: both.id, customer_group_id: defaultGroup.id },
          { customer_id: both.id, customer_group_id: partnerGroup.id },
        ]);
        const minted = await unwrapResponse(
          api.post(
            '/admin/players',
            { count: 1 },
            { headers: { authorization: `Bearer ${adminToken}` } },
          ),
        );
        expect(minted.status).toBe(201);
        const generated = minted.data.players[0].id as string;

        const now = new Date();
        const deposits: [string, number, number | null][] = [
          [real.id, 100, 98],
          [real.id, 50, null],
          [grouped.id, 1000, 1000],
          [generated, 70, 70],
          [both.id, 40, 40],
        ];
        await packs.createGatewayDeposits(
          deposits.map(([customer_id, amount, net], i) => ({
            merchant_transaction_id: `profit-mt-${i}`,
            customer_id,
            amount_requested: amount,
            amount_settled: amount,
            net_amount: net,
            payment_method_code: 'BQR',
            status: 'settled' as const,
            settled_at: now,
          })),
        );
        // Settled by hand: no amount_settled and no net on file. It counts
        // as a top-up whose amount is unknown, never as RM 0.
        await packs.createGatewayDeposits([
          {
            merchant_transaction_id: 'profit-mt-hand',
            customer_id: real.id,
            amount_requested: 300,
            amount_settled: null,
            net_amount: null,
            payment_method_code: 'BQR',
            status: 'settled' as const,
            settled_at: now,
          },
        ]);
        // A pending top-up never counts.
        await packs.createGatewayDeposits([
          {
            merchant_transaction_id: 'profit-mt-pending',
            customer_id: real.id,
            amount_requested: 500,
            payment_method_code: 'BQR',
            status: 'pending' as const,
          },
        ]);
        await packs.createGatewayWithdrawals([
          {
            merchant_transaction_id: 'profit-wd-0',
            customer_id: real.id,
            amount: 60,
            amount_settled: 60,
            net_amount: 61,
            bank_code: 'MBB',
            account_number: '000000000000',
            account_holder_name: 'Profit Test',
            status: 'settled' as const,
            settled_at: now,
          },
          ...([
            ['profit-wd-pending', 25, 'pending'],
            ['profit-wd-held', 10, 'held'],
            ['profit-wd-failed', 99, 'failed'],
          ] as const).map(([merchant_transaction_id, amount, status]) => ({
            merchant_transaction_id,
            customer_id: real.id,
            amount,
            bank_code: 'MBB',
            account_number: '000000000000',
            account_holder_name: 'Profit Test',
            status,
          })),
          {
            merchant_transaction_id: 'profit-wd-grouped-pending',
            customer_id: grouped.id,
            amount: 500,
            bank_code: 'MBB',
            account_number: '000000000000',
            account_holder_name: 'Profit Test',
            status: 'pending' as const,
          },
        ]);

        await packs.createCreditTransactions([
          {
            customer_id: real.id,
            amount: 150,
            reason: 'topup' as const,
            pull_id: null,
            reference: 'profit-topup',
          },
          {
            customer_id: real.id,
            amount: -80,
            reason: 'pack_open' as const,
            pull_id: null,
            reference: null,
          },
          {
            customer_id: real.id,
            amount: 30,
            reason: 'buyback' as const,
            pull_id: null,
            reference: null,
          },
          {
            customer_id: grouped.id,
            amount: 1000,
            reason: 'topup' as const,
            pull_id: null,
            reference: 'profit-topup-g',
          },
          {
            customer_id: grouped.id,
            amount: 200,
            reason: 'bonus_grant' as const,
            pull_id: null,
            reference: 'promo',
            bonus_cents: 20000,
          },
        ]);

        await packs.createCards([
          {
            handle: 'profit-card',
            name: 'Profit Card',
            set: 'QA',
            grader: 'PSA',
            grade: '9',
            market_value: 10,
            image: '/qa.png',
          },
        ]);
        await packs.createPulls([
          {
            customer_id: real.id,
            pack_id: 'profit-pack',
            card_id: 'profit-card',
            status: 'vaulted' as const,
            rolled_at: now,
          },
          {
            customer_id: grouped.id,
            pack_id: 'profit-pack',
            card_id: 'profit-card',
            status: 'delivering' as const,
            rolled_at: now,
          },
        ]);

        const realOnly = await report('?range=all');
        expect(realOnly.status).toBe(200);
        expect(realOnly.data.scope).toBe('default');
        expect(realOnly.data.window).toBeNull();
        expect(realOnly.data.previous).toBeNull();
        expect(realOnly.data.cash).toEqual({
          topups: {
            count: 3,
            gross: 150,
            fees: 2,
            missing_fees: 2, // the no-net deposit and the hand-settled one
            missing_gross: 1,
          },
          withdrawals: {
            count: 1,
            gross: 60,
            fees: 1,
            missing_fees: 0,
            missing_gross: 0,
          },
          kept: 87,
          previous_kept: null,
        });
        expect(realOnly.data.owed).toEqual({
          wallet_cash: 100, // 150 − 80 + 30
          wallet_bonus: 0,
          wallet_no_topup: 0,
          payouts_in_flight: 35, // pending 25 + held 10; failed was refunded
          cards: { count: 1, delivering: 0, sellback: 50.76 },
          total: 185.76,
          all_time_kept: 87,
          if_all_cashed_out: -98.76,
        });
        expect(realOnly.data.activity).toEqual({
          pack_sales: 80,
          sellbacks: 30,
          promo_given: 0,
          delivery_fees: 0,
          referral_commission: 0,
          adjustments: 0,
        });
        expect(Array.isArray(realOnly.data.packs)).toBe(true);

        const all = await report('?range=all&scope=all');
        expect(all.status).toBe(200);
        expect(all.data.scope).toBe('all');
        expect(all.data.cash.topups).toEqual({
          count: 6,
          gross: 1260,
          fees: 2,
          missing_fees: 2,
          missing_gross: 1,
        });
        expect(all.data.owed).toMatchObject({
          wallet_cash: 1100,
          wallet_bonus: 200,
          payouts_in_flight: 535,
          cards: { count: 2, delivering: 1, sellback: 101.52 },
        });
        expect(all.data.activity.promo_given).toBe(200);

        // A real window has a previous one to compare against (0, not null).
        const month = await report('?range=month');
        expect(month.status).toBe(200);
        expect(month.data.range).toBe('month');
        expect(month.data.window).not.toBeNull();
        expect(month.data.previous).not.toBeNull();
        expect(month.data.cash.kept).toBe(87);
        expect(month.data.cash.previous_kept).toBe(0);
        // The default range is this month.
        expect((await report('')).data.range).toBe('month');
      });
    });
  },
});
