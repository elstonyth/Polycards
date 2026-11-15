import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GET /admin/profit-report/pnl, Pack sales (spec plans/pnl-report/SPEC.md §1).
//
// Seeded, all today:
//   real    (no group)  one paid batch open of 2 Bronze (RM 300 each) charged
//                       −600 with −50 bonus; one admin-gift Bronze; one
//                       check-in task's free Bronze; one task CARD reward
//                       (no pack row, so not a pack)
//   grouped (partner)   one paid Bronze open, −300
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin P&L report', () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'pnl-admin@test.dev',
          'pnl-test-password-1',
        );
      });

      const report = (query: string, auth = true) =>
        unwrapResponse(
          api.get(`/admin/profit-report/pnl${query}`, {
            headers: auth ? { authorization: `Bearer ${adminToken}` } : {},
          }),
        );

      it('rejects an unauthenticated read with 401', async () => {
        expect((await report('', false)).status).toBe(401);
      });

      it('answers 400 for a bad scope or range', async () => {
        expect((await report('?scope=partners')).status).toBe(400);
        expect((await report('?range=forever')).status).toBe(400);
        expect((await report('?range=all&range=month')).status).toBe(400);
      });

      it('counts paid opens at full price and free packs at pack price, real customers by default', async () => {
        const container = getContainer();
        const customers = container.resolve(Modules.CUSTOMER);
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

        const [real, grouped] = await customers.createCustomers([
          { email: 'pnl-real@test.dev', has_account: true },
          { email: 'pnl-grouped@test.dev', has_account: true },
        ]);
        const partners = await customers.createCustomerGroups({
          name: 'PnL Partners',
        });
        await customers.addCustomerToGroup([
          { customer_id: grouped.id, customer_group_id: partners.id },
        ]);

        await packs.createPacks([
          {
            slug: 'pnl-bronze',
            title: 'PnL Bronze',
            category: 'pokemon',
            pack_type: 'classic',
            price: 300,
            image: '/cdn/pnl-bronze.webp',
          },
        ] as Parameters<typeof packs.createPacks>[0]);
        const [checkin] = await packs.createTaskDefinitions([
          {
            kind: 'daily' as const,
            title: 'Check in today',
            requirement: { type: 'checkin_days', days: 1 },
            reward: { type: 'pack', pack_id: 'pnl-bronze' },
          },
        ] as Parameters<typeof packs.createTaskDefinitions>[0]);

        const now = new Date();
        const pull = (
          customer_id: string,
          source: 'pack' | 'gift' | 'reward',
          open_id: string | null,
          pack_id = 'pnl-bronze',
        ) => ({
          customer_id,
          pack_id,
          card_id: 'pnl-card',
          status: 'vaulted' as const,
          source,
          open_id,
          rolled_at: now,
        });
        const pulls = await packs.createPulls([
          pull(real.id, 'pack', 'pnl-open-1'),
          pull(real.id, 'pack', 'pnl-open-1'),
          pull(real.id, 'gift', null),
          pull(real.id, 'reward', null),
          pull(real.id, 'reward', null, 'task-reward'),
          pull(grouped.id, 'pack', 'pnl-open-2'),
        ] as Parameters<typeof packs.createPulls>[0]);
        await packs.createTaskClaims([
          {
            customer_id: real.id,
            task_id: checkin.id,
            reward_snapshot: { type: 'pack', pack_id: 'pnl-bronze' },
            claim_ref: pulls[3].id,
          },
        ] as Parameters<typeof packs.createTaskClaims>[0]);
        await packs.createCreditTransactions([
          {
            customer_id: real.id,
            amount: -600,
            bonus_cents: -5000,
            reason: 'pack_open' as const,
            pull_id: null,
            reference: null,
            source_transaction_id: 'pnl-open-1',
          },
          {
            customer_id: grouped.id,
            amount: -300,
            reason: 'pack_open' as const,
            pull_id: null,
            reference: null,
            source_transaction_id: 'pnl-open-2',
          },
        ] as Parameters<typeof packs.createCreditTransactions>[0]);

        const bronzeOf = (body: {
          pack_sales: {
            franchises: {
              category: string;
              types: {
                pack_type: string;
                packs: { slug: string; current: Record<string, unknown> }[];
              }[];
            }[];
          };
        }) =>
          body.pack_sales.franchises
            .find((f) => f.category === 'pokemon')
            ?.types.find((t) => t.pack_type === 'classic')
            ?.packs.find((p) => p.slug === 'pnl-bronze');

        const mine = await report('?range=today');
        expect(mine.status).toBe(200);
        expect(bronzeOf(mine.data)?.current).toEqual({
          opens: 2,
          paid_sen: 60000,
          bonus_sen: 5000,
          free_qty: {
            adjustment: 1,
            checkin: 1,
            task: 0,
            welcome: 0,
            other: 0,
          },
          free_sen: 60000,
          total_sen: 120000,
        });
        expect(mine.data.pack_sales.total.current_sen).toBe(120000);
        // The task CARD reward is no pack: nowhere in the section.
        expect(JSON.stringify(mine.data)).not.toContain('task-reward');

        const all = await report('?range=today&scope=all');
        expect(bronzeOf(all.data)?.current).toMatchObject({
          opens: 3,
          paid_sen: 90000,
          total_sen: 150000,
        });

        // The Excel export: same query, same guard, a real workbook.
        const xlsx = await unwrapResponse(
          api.get('/admin/profit-report/pnl/export?range=today', {
            headers: { authorization: `Bearer ${adminToken}` },
            responseType: 'arraybuffer',
          }),
        );
        expect(xlsx.status).toBe(200);
        expect(xlsx.headers['content-type']).toContain('spreadsheetml');
        expect(xlsx.headers['content-disposition']).toContain('pnl-today-');
        // A zip (PK\x03\x04), not a JSON error.
        expect(Buffer.from(xlsx.data).subarray(0, 2).toString()).toBe('PK');
        expect(
          (
            await unwrapResponse(
              api.get('/admin/profit-report/pnl/export?range=today'),
            )
          ).status,
        ).toBe(401);
      });

      it('COGS = buyback paid + supplier cost of shipped cards, reward cards left out', async () => {
        const container = getContainer();
        const customers = container.resolve(Modules.CUSTOMER);
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const [buyer] = await customers.createCustomers([
          { email: 'pnl-cogs@test.dev', has_account: true },
        ]);
        await packs.createPacks([
          {
            slug: 'pnl-silver',
            title: 'PnL Silver',
            category: 'pokemon',
            pack_type: 'classic',
            price: 600,
            image: '/cdn/pnl-silver.webp',
          },
        ] as Parameters<typeof packs.createPacks>[0]);
        await packs.createCards([
          {
            handle: 'pnl-costed',
            name: 'PnL Costed Card',
            set: 'Test',
            grader: 'PSA',
            grade: '10',
            market_value: 100,
            image: '/cdn/c1.webp',
          },
          {
            handle: 'pnl-uncosted',
            name: 'PnL Uncosted Card',
            set: 'Test',
            grader: 'PSA',
            grade: '10',
            market_value: 10,
            image: '/cdn/c2.webp',
          },
        ] as Parameters<typeof packs.createCards>[0]);
        const now = new Date();
        const pull = (
          card_id: string,
          source: 'pack' | 'reward',
          pack_id: string,
        ) => ({
          customer_id: buyer.id,
          pack_id,
          card_id,
          status: 'vaulted' as const,
          source,
          rolled_at: now,
          recorded_value_usd: 120,
        });
        const [sold, rewardSold, shippedA, shippedB] = await packs.createPulls([
          pull('pnl-costed', 'pack', 'pnl-silver'),
          pull('pnl-costed', 'reward', 'task-reward'),
          pull('pnl-costed', 'pack', 'pnl-silver'),
          pull('pnl-uncosted', 'pack', 'pnl-silver'),
        ] as Parameters<typeof packs.createPulls>[0]);
        await packs.createCreditTransactions([
          {
            customer_id: buyer.id,
            amount: 500,
            reason: 'buyback' as const,
            pull_id: sold.id,
            reference: null,
          },
          {
            customer_id: buyer.id,
            amount: 77,
            reason: 'buyback' as const,
            pull_id: rewardSold.id,
            reference: null,
          },
        ] as Parameters<typeof packs.createCreditTransactions>[0]);
        const [order] = await packs.createDeliveryOrders([
          {
            customer_id: buyer.id,
            status: 'shipped' as const,
            ship_name: 'PnL',
            ship_address_1: '1 Test Street',
            ship_city: 'KL',
            ship_postal_code: '50000',
            ship_country_code: 'my',
            shipped_at: now,
          },
        ] as Parameters<typeof packs.createDeliveryOrders>[0]);
        await packs.createDeliveryOrderItems([
          { delivery_order_id: order.id, pull_id: shippedA.id },
          { delivery_order_id: order.id, pull_id: shippedB.id },
        ]);
        const [invoice] = await packs.createPurchaseInvoices([
          {
            display_no: 'PI-PNL-1',
            date: now,
            supplier: 'PnL Supplier',
            agent_user_id: 'user_pnl',
          },
        ] as Parameters<typeof packs.createPurchaseInvoices>[0]);
        await packs.createPurchaseInvoiceLines([
          {
            invoice_id: invoice.id,
            card_handle: 'pnl-costed',
            card_name: 'PnL Costed Card',
            fmv_snapshot: 400,
            qty: 2,
            unit_cost: 250,
            line_total: 500,
          },
        ] as Parameters<typeof packs.createPurchaseInvoiceLines>[0]);

        // Its own query: the route keeps each query's result 5 minutes, so
        // reusing the earlier test's ?range=today would read that result.
        const today = new Date().toLocaleDateString('en-CA', {
          timeZone: 'Asia/Kuala_Lumpur',
        });
        const res = await report(`?range=custom&from=${today}&to=${today}`);
        expect(res.status).toBe(200);
        const silver = res.data.cogs.franchises
          .find((f: { category: string }) => f.category === 'pokemon')
          .types.find((t: { pack_type: string }) => t.pack_type === 'classic')
          .packs.find((p: { slug: string }) => p.slug === 'pnl-silver');
        // No fx_rate row and no fx_rate_day row: every day prices at the 4.7 default.
        expect(silver.current).toEqual({
          pulls: 3,
          pulled_sen: 3 * 120 * 470,
          buyback_sen: 50000,
          shipped_cards: 2,
          shipped_cost_sen: 25000 + 10 * 470,
          estimated_cards: 1,
          total_sen: 50000 + 25000 + 4700,
        });
        expect(res.data.cogs.estimated_cards).toBe(1);
        expect(res.data.cogs.purchase.current_sen).toBe(50000);
        // The reward card's buyback (RM 77) is a marketing cost: nowhere in COGS.
        expect(res.data.cogs.total.current_sen).toBe(79700);
      });

      it('keeps a closed period 6 hours and an open one 5 minutes, balances always 5 minutes', async () => {
        const cache = getContainer().resolve(Modules.CACHE);
        // An earlier case already worked out the scope's balances.
        await cache.invalidate('pnl-report:balance|all');
        const set = jest.spyOn(cache, 'set');
        try {
          // Distinct scope so no earlier case's run is reused.
          const closed = await report('?range=yesterday&scope=all');
          expect(closed.status).toBe(200);
          const open = await report('?range=7d&scope=all');
          expect(open.status).toBe(200);
          const ttlOf = (prefix: string) =>
            set.mock.calls
              .filter(([k]) => String(k).startsWith(`pnl-report:${prefix}`))
              .map(([, , ttl]) => ttl);
          expect(ttlOf('yesterday|')).toEqual([6 * 60 * 60]);
          expect(ttlOf('7d|')).toEqual([5 * 60]);
          // Kept apart, so a long-kept period never shows old balances.
          expect(ttlOf('balance|')).toEqual([5 * 60]);
          expect(closed.data.balance_as_of).toEqual(expect.any(String));
          expect(Date.parse(closed.data.window.to)).toBeLessThan(
            Date.parse(closed.data.as_of),
          );
        } finally {
          set.mockRestore();
        }
      });
    });
  },
});
