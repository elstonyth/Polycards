// integration-tests/http/vip-levelup-e2e.spec.ts
//
// End-to-end money -> level -> reward -> display proof for the VIP leveling
// system. This is the one path the rest of the vip-* suites do NOT cover:
//   - vip-ladder / vip-rewards / vip-levels-*      -> pure math, no DB
//   - vip-settle-step.unit                          -> workflow step with a
//                                                      MOCKED grantLevelUpRewards
//   - vip-member-state (module)                     -> rebuild via direct module
//                                                      calls, not a real open
//   - store-vip / admin-gacha-vip (http)            -> route reads with a SEEDED
//                                                      state row, no real open
//
// Here we drive a REAL open through openPackWorkflow (which calls settleVipStep
// in-saga), cross two ladder rungs on external-funded spend, and assert the
// whole chain: current_level advances, monotonic highest_level_ever, the
// vip_reward_grant voucher rows land (origin 'ladder', status 'granted'), and
// GET /store/vip surfaces the new level + next-rung teaser the storefront reads.
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'vip-e2e-pw-1';
const PACK_SLUG = 'vip-e2e-pack';
const CARD_HANDLE = 'vip-e2e-card';
const PACK_PRICE = 10;
// Ladder anchors from vip-levels.data.ts: L2 = 3 MYR, L3 = 25 MYR, L4 = 83 MYR.
// Top up 30 and open 3x (=30 external-funded spend) crosses L2 and L3, lands on
// L3, with L4 still ahead (30 < 83).
const TOPUP = 30;
const OPENS = 3;
const EXPECTED_SPEND = PACK_PRICE * OPENS; // 30
const EXPECTED_LEVEL = 3;
const L4_THRESHOLD = 83;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('VIP leveling — real open -> level-up -> grant -> /store/vip', () => {
      let storeHeaders: Record<string, string>;

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      // Returns the id alongside the token so every assertion can be scoped to
      // THIS customer rather than relying on a globally-empty table.
      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; id: string }> => {
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
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        return { token: login.data.token, id: created.data.customer.id };
      };

      const open = (headers: Record<string, string>) =>
        unwrapResponse(
          api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers }),
        );

      const topUp = (amount: number, headers: Record<string, string>) =>
        unwrapResponse(
          api.post(
            '/store/credits/topup',
            { amount },
            {
              headers: {
                ...headers,
                'idempotency-key': `vip-e2e-topup-${amount}`,
              },
            },
          ),
        );

      const getVip = (headers: Record<string, string>) =>
        unwrapResponse(api.get('/store/vip', { headers }));

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'vip-e2e-test',
          type: 'publishable',
          created_by: 'vip-e2e-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

        // The integration runner runs migrations but NOT the seed, so vip_level
        // is empty by default. Establish the CANONICAL ladder unconditionally
        // rather than "seed only when empty": the last case wipes the ladder,
        // so a conditional seed would silently accept whatever a prior//future
        // test happened to leave behind.
        const staleLadder = await packs.listVipLevels({}, { take: 1000 });
        if (staleLadder.length > 0) {
          await packs.deleteVipLevels(staleLadder.map((r) => r.id));
        }
        await packs.createVipLevels(
          VIP_LEVELS.map((r) => ({
            level: r.level,
            spend_threshold: r.spend_threshold,
            voucher_amount: r.voucher_amount,
            box_tier: r.box_tier,
            frame_unlock: r.frame_unlock,
            direct_referral_pct: r.direct_referral_pct,
            prizes: r.prizes ?? null,
          })),
        );

        // Single-card pool → deterministic roll (the only card always wins).
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'VIP E2E Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: 90,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'VIP E2E Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            market_multiplier: 1.2,
            image: '/cdn/test-card.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: 'Rare' as const,
          },
        ]);
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: 4.0,
            source: 'test',
            manual_override: true,
            manual_rate: 4.0,
          },
        ]);

        // Tracked inventory so the in-saga stock earmark has a target (matches
        // the proven pack-open-charge setup).
        const productModule = container.resolve(Modules.PRODUCT);
        const [product] = await productModule.createProducts([
          {
            title: 'VIP E2E Card PSA 10',
            handle: CARD_HANDLE,
            status: 'published',
            options: [{ title: 'Format', values: ['Slab'] }],
            variants: [
              {
                title: 'Slab',
                sku: `CARD-${CARD_HANDLE.toUpperCase()}`,
                manage_inventory: true,
                options: { Format: 'Slab' },
              },
            ],
          },
        ]);
        const stockLocationModule = container.resolve(Modules.STOCK_LOCATION);
        const location = await stockLocationModule.createStockLocations({
          name: 'VIP E2E Warehouse',
        });
        const inventoryModule = container.resolve(Modules.INVENTORY);
        const item = await inventoryModule.createInventoryItems({
          sku: `CARD-${CARD_HANDLE.toUpperCase()}`,
        });
        await inventoryModule.createInventoryLevels([
          {
            inventory_item_id: item.id,
            location_id: location.id,
            stocked_quantity: 100,
          },
        ]);
        const link = container.resolve(ContainerRegistrationKeys.LINK);
        await link.create({
          [Modules.PRODUCT]: { variant_id: product.variants[0].id },
          [Modules.INVENTORY]: { inventory_item_id: item.id },
        });
      });

      it('a fresh customer sits at L1 with the L2 teaser and no grants', async () => {
        const { token, id: customerId } = await registerCustomer(
          'vip-e2e-fresh@test.dev',
        );

        const res = await getVip(authed(token));
        expect(res.status).toBe(200);
        expect(res.data.level).toBe(1);
        expect(res.data.highest_level_ever).toBe(1);
        expect(res.data.spend).toBe(0);
        // L2 rung: threshold 3, remaining 3 (nothing spent yet).
        expect(res.data.next).toMatchObject({
          level: 2,
          threshold: 3,
          remaining: 3,
        });
        expect(res.data.next.reward).toHaveProperty('box_tier');

        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const grants = await packs.listVipRewardGrants(
          { customer_id: customerId },
          { take: 100 },
        );
        expect(grants).toHaveLength(0);
      });

      it('opens crossing L2+L3 advance the level, grant vouchers, and surface on /store/vip', async () => {
        const { token, id: customerId } = await registerCustomer(
          'vip-e2e-climb@test.dev',
        );

        expect((await topUp(TOPUP, authed(token))).status).toBe(200);

        for (let i = 0; i < OPENS; i++) {
          const opened = await open(authed(token));
          expect(opened.status).toBe(200);
          expect(opened.data.card.handle).toBe(CARD_HANDLE);
        }

        // --- Display path: GET /store/vip reflects the climb -----------------
        const vip = await getVip(authed(token));
        expect(vip.status).toBe(200);
        expect(vip.data.spend).toBe(EXPECTED_SPEND); // 30 external-funded
        expect(vip.data.level).toBe(EXPECTED_LEVEL); // L3
        expect(vip.data.highest_level_ever).toBe(EXPECTED_LEVEL); // monotonic
        // Next rung is L4 (83 MYR), remaining = 83 - 30 = 53.
        expect(vip.data.next).toMatchObject({
          level: EXPECTED_LEVEL + 1,
          threshold: L4_THRESHOLD,
          remaining: L4_THRESHOLD - EXPECTED_SPEND,
        });

        // --- Grant path: L2 + L3 voucher rows landed via the in-saga settle ---
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const grants = await packs.listVipRewardGrants(
          { customer_id: customerId },
          { take: 100 },
        );
        const byLevel = new Map(grants.map((g) => [Number(g.level), g]));
        // L2 (voucher 2) and L3 (voucher 2) both have voucher_amount > 0, no
        // frame_unlock, so exactly one 'voucher' grant each — 2 rows total.
        expect(grants).toHaveLength(2);
        expect([...byLevel.keys()].sort((a, b) => a - b)).toEqual([2, 3]);
        for (const level of [2, 3]) {
          const g = byLevel.get(level)!;
          expect(g.kind).toBe('voucher');
          expect(g.origin).toBe('ladder');
          expect(g.status).toBe('granted');
          expect(g.source_open_id).toBeTruthy();
        }

        // --- Member-state projection matches the ledger ----------------------
        const [state] = await packs.listVipMemberStates(
          { customer_id: customerId },
          { take: 1 },
        );
        expect(Number(state.current_level)).toBe(EXPECTED_LEVEL);
        expect(Number(state.highest_level_ever)).toBe(EXPECTED_LEVEL);
      });

      it('an empty vip_level ladder strands every customer at L1 (prod failure mode)', async () => {
        // Prove the documented risk: if migrations ran but the ladder was never
        // seeded, the route floors everyone at L1 with no next teaser. This is
        // the shape a 'leveling isn't working' prod report would take.
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const ladder = await packs.listVipLevels({}, { take: 1000 });
        await packs.deleteVipLevels(ladder.map((r) => r.id));

        const { token } = await registerCustomer('vip-e2e-noladder@test.dev');
        await topUp(TOPUP, authed(token));
        for (let i = 0; i < OPENS; i++) {
          expect((await open(authed(token))).status).toBe(200);
        }

        const vip = await getVip(authed(token));
        expect(vip.status).toBe(200);
        expect(vip.data.level).toBe(1); // stranded despite 30 MYR spent
        expect(vip.data.next).toBeNull(); // no rung to show
      });
    });
  },
});
