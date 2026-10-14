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
        // A repeated range arrives as an array: refused, never "this month".
        expect((await report('?range=all&range=month')).status).toBe(400);
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
          fx_earned: 0,
          kept: 87,
          previous_kept: null,
        });
        expect(realOnly.data.owed).toEqual({
          wallet_cash: 100, // 150 − 80 + 30
          wallet_bonus: 0,
          wallet_no_topup: 0,
          payouts_in_flight: 35, // pending 25 + held 10; failed was refunded
          commission_unpaid: 0,
          cards: { count: 1, delivering: 0, sellback: 50.76 },
          cards_no_topup: { count: 0, sellback: 0 },
          total: 185.76,
          all_time_kept: 87,
          shipped: { count: 0, value: 0 },
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

      // Windows, the FX spread, the payout fee direction, unpaid commission,
      // shipped cards and never-topped-up players (review of #775).
      //   real    ledger topup 500, open −100 (wallet 400); deposits 300 now
      //           (net 294), 200 45 days ago (net 196), S$100 at mid 3.2
      //           credited RM 318 (spread RM 2); payout 50 whose net was
      //           stored as 49 (pre-2026-09-10 TGPay rows: fee still 1);
      //           commission lines: pending 15.00 (owed), paid, voided; cards:
      //           one vaulted, one delivered (shipped, a cost not a debt)
      //   neg     topup 10, open −30: a negative balance owes nobody
      //   notopup adjustment 40, never topped up: can't withdraw or ship, so
      //           its wallet and its vaulted card are reported, not owed
      it('values windows, FX spread, unpaid commission, shipped and never-topped-up cards', async () => {
        const container = getContainer();
        const customers = container.resolve(Modules.CUSTOMER);
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const [real, neg, notopup] = await customers.createCustomers([
          { email: 'profit2-real@test.dev', has_account: true },
          { email: 'profit2-neg@test.dev', has_account: true },
          { email: 'profit2-notopup@test.dev', has_account: true },
        ]);
        const now = new Date();
        const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

        await packs.createCreditTransactions([
          { customer_id: real.id, amount: 500, reason: 'topup' as const, pull_id: null, reference: 'p2-t1' },
          { customer_id: real.id, amount: -100, reason: 'pack_open' as const, pull_id: null, reference: null },
          { customer_id: neg.id, amount: 10, reason: 'topup' as const, pull_id: null, reference: 'p2-t2' },
          { customer_id: neg.id, amount: -30, reason: 'pack_open' as const, pull_id: null, reference: null },
          { customer_id: notopup.id, amount: 40, reason: 'adjustment' as const, pull_id: null, reference: 'grant' },
        ]);

        await packs.createGatewayDeposits([
          {
            merchant_transaction_id: 'p2-now',
            customer_id: real.id,
            amount_requested: 300,
            amount_settled: 300,
            net_amount: 294,
            payment_method_code: 'BQR',
            status: 'settled' as const,
            settled_at: now,
          },
          {
            merchant_transaction_id: 'p2-old',
            customer_id: real.id,
            amount_requested: 200,
            amount_settled: 200,
            net_amount: 196,
            payment_method_code: 'BQR',
            status: 'settled' as const,
            settled_at: daysAgo(45),
          },
          {
            merchant_transaction_id: 'p2-sgd',
            customer_id: real.id,
            amount_requested: 318,
            amount_settled: 318,
            net_amount: 318,
            payment_method_code: 'PAYNOW',
            status: 'settled' as const,
            settled_at: now,
            gateway: 'a3pay',
            currency: 'SGD',
            gateway_amount: 100,
            fx_mid: 3.2,
            fx_markup: 0.02,
          },
          {
            merchant_transaction_id: 'p2-neg',
            customer_id: neg.id,
            amount_requested: 10,
            amount_settled: 10,
            net_amount: 10,
            payment_method_code: 'BQR',
            status: 'settled' as const,
            settled_at: now,
          },
        ]);
        await packs.createGatewayWithdrawals([
          {
            merchant_transaction_id: 'p2-wd',
            customer_id: real.id,
            amount: 50,
            amount_settled: 50,
            net_amount: 49,
            bank_code: 'MBB',
            account_number: '000000000000',
            account_holder_name: 'Profit Test',
            status: 'settled' as const,
            settled_at: now,
          },
        ]);

        // One line per customer per settlement: the pending line is owed (its
        // week is still draft); a paid line and a pending line in a voided
        // week are not.
        const weeks = await packs.createWeeklySettlements([
          { week_start: daysAgo(3), status: 'draft' as const },
          { week_start: daysAgo(10), status: 'paid' as const },
          { week_start: daysAgo(17), status: 'void' as const },
        ]);
        await packs.createWeeklySettlementLines(
          (
            [
              [weeks[0].id, 'pending', 1500],
              [weeks[1].id, 'paid', 999],
              [weeks[2].id, 'pending', 777],
            ] as const
          ).map(([settlement_id, status, amount_cents]) => ({
            settlement_id,
            customer_id: real.id,
            basis_cents: 100000,
            rate_bp: 150,
            amount_cents,
            status,
          })),
        );

        await packs.createCards([
          {
            handle: 'profit2-card',
            name: 'Profit2 Card',
            set: 'QA',
            grader: 'PSA',
            grade: '9',
            market_value: 10,
            image: '/qa.png',
          },
        ]);
        await packs.createPulls(
          (
            [
              [real.id, 'vaulted'],
              [real.id, 'delivered'],
              [notopup.id, 'vaulted'],
            ] as const
          ).map(([customer_id, status]) => ({
            customer_id,
            pack_id: 'profit2-pack',
            card_id: 'profit2-card',
            status,
            rolled_at: now,
          })),
        );

        const r = await report('?range=30d');
        expect(r.status).toBe(200);
        expect(r.data.cash).toEqual({
          topups: { count: 3, gross: 628, fees: 6, missing_fees: 0, missing_gross: 0 },
          withdrawals: { count: 1, gross: 50, fees: 1, missing_fees: 0, missing_gross: 0 },
          fx_earned: 2,
          kept: 573, // 628 − 6 − 50 − 1 + 2
          previous_kept: 196, // the 45-day-old deposit, net of its fee
        });
        expect(r.data.owed).toEqual({
          wallet_cash: 400, // real 400 + neg clamped to 0
          wallet_bonus: 0,
          wallet_no_topup: 40,
          payouts_in_flight: 0,
          commission_unpaid: 15,
          cards: { count: 1, delivering: 0, sellback: 50.76 },
          cards_no_topup: { count: 1, sellback: 50.76 },
          total: 465.76, // 400 + 0 + 15 + 50.76
          all_time_kept: 769, // 573 + 196
          shipped: { count: 1, value: 50.76 },
          if_all_cashed_out: 252.48, // 769 − 465.76 − 50.76
        });

        // All time = the current window and the previous one together.
        const all = await report('?range=all');
        expect(all.data.cash.kept).toBe(769);
        expect(all.data.owed.all_time_kept).toBe(769);
      });
    });
  },
});
