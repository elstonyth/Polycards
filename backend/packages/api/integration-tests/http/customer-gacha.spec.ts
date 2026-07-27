import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'gacha-view-password-1';

// Support view aggregate: GET /admin/customers/:id/gacha returns everything
// an operator needs for one customer — identity, credit balance, recent
// ledger, recent pulls (card-joined), and a vault summary (count + FMV owed).

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin customer gacha view', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'customer-gacha-test',
          type: 'publishable',
          created_by: 'customer-gacha-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminToken = await mintSuperAdmin(
          container,
          api,
          'gacha-view-admin@test.dev',
          PASSWORD,
        );
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      const registerCustomer = async (email: string): Promise<string> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const created = await api.post(
          '/store/customers',
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        return created.data.customer.id;
      };

      const view = (customerId: string, headers: Record<string, string>) =>
        unwrapResponse(
          api.get(`/admin/customers/${customerId}/gacha`, { headers }),
        );

      it('rejects an unauthenticated read with 401 and 404s unknown customers', async () => {
        const customerId = await registerCustomer('gacha-view-a@test.dev');
        expect((await view(customerId, {})).status).toBe(401);
        expect((await view('cus_ghost', adminHeaders())).status).toBe(404);
      });

      it('aggregates balance, ledger, pulls (card-joined), and vault summary', async () => {
        const customerId = await registerCustomer('gacha-view-b@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        // Ledger: +20 adjustment, -5 pack_open → balance 15.
        await packs.createCreditTransactions([
          {
            customer_id: customerId,
            amount: 20,
            reason: 'adjustment' as const,
            pull_id: null,
            reference: 'seed grant',
          },
          {
            customer_id: customerId,
            amount: -5,
            reason: 'pack_open' as const,
            pull_id: null,
            reference: null,
          },
        ]);

        // Pulls: one vaulted ($12.5 USD FMV → RM62.5 at the explicit 5.0 FX
        // seeded below, counts toward the vault summary), one bought back
        // (excluded). Direct rows — the aggregate only joins Card by handle, no
        // product chain.
        await packs.createCards([
          {
            handle: 'gacha-view-card',
            name: 'Gacha View Card',
            set: 'QA',
            grader: 'PSA',
            grade: '10',
            market_value: 12.5,
            image: '/qa.png',
          },
        ]);
        await packs.createPulls([
          {
            customer_id: customerId,
            pack_id: 'qa-pack',
            card_id: 'gacha-view-card',
            status: 'vaulted' as const,
            rolled_at: new Date(Date.now() - 60_000),
          },
          {
            customer_id: customerId,
            pack_id: 'qa-pack',
            card_id: 'gacha-view-card',
            status: 'bought_back' as const,
            buyback_amount: 11,
            rolled_at: new Date(),
          },
        ]);

        // Seed an explicit USD→MYR rate so the assertions pin the conversion at
        // a NON-default rate — proves resolveFxRate + displayMarketPrice are
        // actually applied here, not that the numbers happen to match
        // DEFAULT_USD_MYR.
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: 5,
            source: 'test',
            manual_override: false,
            manual_rate: null,
          },
        ]);

        const res = await view(customerId, adminHeaders());
        expect(res.status).toBe(200);

        expect(res.data.customer).toMatchObject({
          id: customerId,
          email: 'gacha-view-b@test.dev',
        });
        expect(res.data.balance).toBe(15);

        // Both rows were batch-inserted with one created_at, so DESC order is
        // a tie — assert the set, not the position.
        expect(res.data.transactions).toHaveLength(2);
        expect(
          res.data.transactions
            .map((t: { amount: number }) => t.amount)
            .sort((a: number, b: number) => a - b),
        ).toEqual([-5, 20]);

        expect(res.data.pulls).toHaveLength(2);
        const vaulted = res.data.pulls.find(
          (p: { status: string }) => p.status === 'vaulted',
        );
        expect(vaulted).toBeDefined();
        expect(vaulted.card).toMatchObject({
          handle: 'gacha-view-card',
          name: 'Gacha View Card',
          market_value: 62.5,
        });

        // market_value = FMV at multiplier 1 (12.5 × 5); display_value = the
        // storefront price, FMV × the card's market_multiplier (DB default 1.2).
        expect(res.data.vault).toEqual({
          count: 1,
          market_value: 62.5,
          display_value: 75,
        });
      });

      it('vip.next carries the next rung (threshold + remaining); null at the top', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createVipLevels(
          [
            { level: 1, spend_threshold: 0 },
            { level: 2, spend_threshold: 100 },
            { level: 3, spend_threshold: 500 },
          ].map((r) => ({
            ...r,
            voucher_amount: 0,
            box_tier: 'bronze',
            frame_unlock: false,
            direct_referral_pct: 1,
            prizes: null,
          })),
        );

        // Mid-ladder: RM150 of pack_open turnover → L2, next rung is L3.
        const midId = await registerCustomer('gacha-view-vip-mid@test.dev');
        await packs.createCreditTransactions([
          {
            customer_id: midId,
            amount: -150,
            reason: 'pack_open' as const,
            pull_id: null,
            reference: null,
          },
        ]);
        const mid = await view(midId, adminHeaders());
        expect(mid.status).toBe(200);
        expect(mid.data.vip).toMatchObject({
          level: 2,
          highest_level_ever: 2,
          spend: 150,
        });
        expect(mid.data.vip.next).toEqual({
          level: 3,
          threshold: 500,
          remaining: 350,
        });

        // Top of the ladder: no rung above L3 → next is null (not undefined).
        const topId = await registerCustomer('gacha-view-vip-top@test.dev');
        await packs.createCreditTransactions([
          {
            customer_id: topId,
            amount: -500,
            reason: 'pack_open' as const,
            pull_id: null,
            reference: null,
          },
        ]);
        const top = await view(topId, adminHeaders());
        expect(top.status).toBe(200);
        expect(top.data.vip.level).toBe(3);
        expect(top.data.vip.next).toBeNull();
      });
    });
  },
});
