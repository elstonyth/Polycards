import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GET /admin/customers/:id/money — the player page's money card: one
// customer's top-ups and withdrawals per window (credit ledger, the Players
// list's sums), and the Profit report's cash kept and still owed run for
// that customer alone.
//
// Seeded, all today:
//   player  deposits 100 (net 98) + 50 (no net yet); payout 60 settled (net
//           61) + 25 pending; ledger topup 150, cashout −60 and −25, open
//           −80, buyback +30; one vaulted $10 card from a paid pack
//   other   deposit 1000, ledger topup 1000, cashout −500, payout 500
//           pending, a vaulted card: must never leak into the player's
// No FxRate row → the 4.7 default; the $10 card at the 1.2 default
// multiplier is RM 56.40 display, RM 50.76 at the 90% sell-back.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin customer money', () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'money-admin@test.dev',
          'money-test-password-1',
        );
      });

      const money = (id: string, auth = true) =>
        unwrapResponse(
          api.get(`/admin/customers/${id}/money`, {
            headers: auth ? { authorization: `Bearer ${adminToken}` } : {},
          }),
        );

      it('rejects an unauthenticated read and answers 404 for no customer', async () => {
        expect((await money('cus_nobody', false)).status).toBe(401);
        expect((await money('cus_nobody')).status).toBe(404);
      });

      it("counts this customer's money only", async () => {
        const container = getContainer();
        const customers = container.resolve(Modules.CUSTOMER);
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const [player, other] = await customers.createCustomers([
          { email: 'money-player@test.dev', has_account: true },
          { email: 'money-other@test.dev', has_account: true },
        ]);

        const now = new Date();
        const deposits: [string, number, number | null][] = [
          [player.id, 100, 98],
          [player.id, 50, null],
          [other.id, 1000, 1000],
        ];
        await packs.createGatewayDeposits(
          deposits.map(([customer_id, amount, net], i) => ({
            merchant_transaction_id: `money-mt-${i}`,
            customer_id,
            amount_requested: amount,
            amount_settled: amount,
            net_amount: net,
            payment_method_code: 'BQR',
            status: 'settled' as const,
            settled_at: now,
          })),
        );
        const payout = {
          bank_code: 'MBB',
          account_number: '000000000000',
          account_holder_name: 'Money Test',
        };
        await packs.createGatewayWithdrawals([
          {
            ...payout,
            merchant_transaction_id: 'money-wd-0',
            customer_id: player.id,
            amount: 60,
            amount_settled: 60,
            net_amount: 61,
            status: 'settled' as const,
            settled_at: now,
          },
          {
            ...payout,
            merchant_transaction_id: 'money-wd-pending',
            customer_id: player.id,
            amount: 25,
            status: 'pending' as const,
          },
          {
            ...payout,
            merchant_transaction_id: 'money-wd-other',
            customer_id: other.id,
            amount: 500,
            status: 'pending' as const,
          },
        ]);
        const row = (customer_id: string, amount: number, reason: string) => ({
          customer_id,
          amount,
          reason: reason as 'topup',
          pull_id: null,
          reference: null,
        });
        await packs.createCreditTransactions([
          row(player.id, 150, 'topup'),
          row(player.id, -60, 'cashout'),
          row(player.id, -25, 'cashout'),
          row(player.id, -80, 'pack_open'),
          row(player.id, 30, 'buyback'),
          row(other.id, 1000, 'topup'),
          row(other.id, -500, 'cashout'),
        ]);
        await packs.createCards([
          {
            handle: 'money-card',
            name: 'Money Card',
            set: 'QA',
            grader: 'PSA',
            grade: '9',
            market_value: 10,
            image: '/qa.png',
          },
        ]);
        await packs.createPulls(
          [player.id, other.id].map((customer_id) => ({
            customer_id,
            pack_id: 'money-pack',
            card_id: 'money-card',
            status: 'vaulted' as const,
            rolled_at: now,
          })),
        );

        const res = await money(player.id);
        expect(res.status).toBe(200);
        const period = {
          topups: { count: 1, amount: 150 },
          withdrawals: { count: 2, amount: 85 },
          contribution: 65,
        };
        expect(res.data.periods).toEqual({
          today: period,
          d7: period,
          month: period,
          all: period,
        });
        expect(Object.keys(res.data.windows)).toEqual(['today', 'd7', 'month']);
        expect(res.data.last.topup_at).not.toBeNull();
        expect(res.data.last.withdrawal_at).not.toBeNull();
        expect(res.data.last.open_at).not.toBeNull();
        expect(res.data.cash).toEqual({
          topups: {
            count: 2,
            gross: 150,
            fees: 2,
            missing_fees: 1,
            missing_gross: 0,
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
        expect(res.data.owed).toEqual({
          wallet_cash: 15, // 150 − 60 − 25 − 80 + 30
          wallet_bonus: 0,
          wallet_no_topup: 0,
          payouts_in_flight: 25,
          commission_unpaid: 0,
          cards: { count: 1, delivering: 0, sellback: 50.76 },
          cards_no_topup: { count: 0, sellback: 0 },
          total: 90.76,
          all_time_kept: 87,
          shipped: { count: 0, value: 0 },
          if_all_cashed_out: -3.76,
        });
        expect(res.data.activity).toMatchObject({
          pack_sales: 80,
          sellbacks: 30,
        });
        expect(res.data.play).toEqual({
          cards_won: { count: 1, value: 56.4 },
          return_pct: 70.5,
        });

        // The other customer's own card stands alone too.
        const theirs = await money(other.id);
        expect(theirs.data.periods.all.contribution).toBe(500);
        expect(theirs.data.owed.payouts_in_flight).toBe(500);
        expect(theirs.data.play.return_pct).toBeNull();

        // The wallet as the withdraw button sees it (walletSummary). These
        // ledger top-ups carry no playthrough basis, so nothing is held.
        expect(res.data.wallet).toEqual({
          balance: 15,
          withdrawable: 15,
          bonus: 0,
          frozen: false,
          has_topup: true,
          playthrough: { deposited: 0, used: 0, remaining: 0 },
        });

        // The Wallet tab's type filter.
        const get = (path: string) =>
          unwrapResponse(
            api.get(path, {
              headers: { authorization: `Bearer ${adminToken}` },
            }),
          );
        const moneyRows = await get(
          `/admin/customers/${player.id}/transactions?reasons=topup,cashout`,
        );
        expect(moneyRows.status).toBe(200);
        expect(moneyRows.data.total).toBe(3);
        expect(
          moneyRows.data.items.map((r: { reason: string }) => r.reason).sort(),
        ).toEqual(['cashout', 'cashout', 'topup']);
        expect(
          (
            await get(
              `/admin/customers/${player.id}/transactions?reasons=refund`,
            )
          ).status,
        ).toBe(400);
        expect(
          (await get(`/admin/customers/${player.id}/transactions`)).data.total,
        ).toBe(5);
      });

      it('sorts a vault by value, highest first', async () => {
        const container = getContainer();
        const customers = container.resolve(Modules.CUSTOMER);
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const [collector] = await customers.createCustomers([
          { email: 'money-vault@test.dev', has_account: true },
        ]);
        await packs.createPacks([
          {
            slug: 'money-vault-pack',
            title: 'Money Vault Pack',
            category: 'pokemon',
            price: 10,
            image: '/x.webp',
          },
        ]);
        await packs.createCards(
          [
            ['money-cheap', 5],
            ['money-dear', 50],
            ['money-mid', 20],
          ].map(([handle, market_value]) => ({
            handle: handle as string,
            name: handle as string,
            set: 'QA',
            grader: 'PSA',
            grade: '9',
            market_value: market_value as number,
            image: '/qa.png',
          })),
        );
        // Newest first by default: cheap (now), mid (−1 min), dear (−2 min).
        const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);
        await packs.createPulls(
          (
            [
              ['money-cheap', 0],
              ['money-mid', 1],
              ['money-dear', 2],
            ] as const
          ).map(([card_id, ago]) => ({
            customer_id: collector.id,
            pack_id: 'money-vault-pack',
            card_id,
            status: 'vaulted' as const,
            rolled_at: at(ago),
          })),
        );
        const list = (query: string) =>
          unwrapResponse(
            api.get(`/admin/customers/${collector.id}/pulls${query}`, {
              headers: { authorization: `Bearer ${adminToken}` },
            }),
          );
        const handles = (r: {
          data: { items: { card: { handle: string } }[] };
        }) => r.data.items.map((p) => p.card.handle);

        const newest = await list('?status=vaulted');
        expect(handles(newest)).toEqual([
          'money-cheap',
          'money-mid',
          'money-dear',
        ]);
        expect(newest.data.items[0].pack_title).toBe('Money Vault Pack');

        const byValue = await list('?status=vaulted&sort=value');
        expect(byValue.status).toBe(200);
        expect(byValue.data.total).toBe(3);
        expect(handles(byValue)).toEqual([
          'money-dear',
          'money-mid',
          'money-cheap',
        ]);
        // Paged after sorting, not before.
        const second = await list(
          '?status=vaulted&sort=value&limit=1&offset=1',
        );
        expect(handles(second)).toEqual(['money-mid']);

        expect((await list('?sort=price')).status).toBe(400);
      });
    });
  },
});
