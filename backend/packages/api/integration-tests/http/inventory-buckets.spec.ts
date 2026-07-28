import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'inventory-buckets-test-pw-1'; // gitleaks:allow
const ADMIN_EMAIL = 'inventory-buckets-admin@test.dev';

const ADDRESS = {
  ship_name: 'Ada',
  ship_address_1: '1 Way',
  ship_address_2: null,
  ship_city: 'KL',
  ship_province: null,
  ship_postal_code: '50000',
  ship_country_code: 'my',
  ship_phone: null,
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('inventory stock buckets — full lifecycle', () => {
      let adminToken: string;
      let packs: PacksModuleService;

      beforeEach(async () => {
        packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        // A fresh test DB has NO fx_rate row, so resolveFxRateStrict refuses
        // every purchase-invoice create. Pin a firm rate before any other call
        // (it caches in-process for 30s, so it must come first).
        await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            { manual_override: true, manual_rate: 4.5, reason: 'pin for test' },
            { headers: { authorization: `Bearer ${adminToken}` } },
          ),
        );
      });

      const adminHeaders = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const buy = (
        lines: unknown[],
        reversesInvoiceId: string | null = null,
        date = '2026-07-28T00:00:00.000Z',
      ) =>
        unwrapResponse(
          api.post(
            '/admin/purchase-invoices',
            {
              date,
              supplier: 'Test Supplier',
              reverses_invoice_id: reversesInvoiceId,
              lines,
            },
            adminHeaders(),
          ),
        );

      const bucketsFor = async (handle: string) =>
        (await packs.inventoryLifecycleBuckets([handle])).get(handle);

      const costFor = async (handle: string) =>
        (await packs.weightedAverageCostByHandle([handle])).get(handle);

      it('purchase -> pull -> delivery request -> shipped moves the card between buckets, one at a time', async () => {
        const HANDLE = 'lifecycle-card';

        // 1. PURCHASE — through the real Task-3 route, not a hand-seeded row.
        const purchase = await buy([
          {
            card_handle: HANDLE,
            card_name: 'Lifecycle Card',
            fmv_snapshot: 100,
            qty: 5,
            unit_cost: 50,
          },
        ]);
        expect(purchase.status).toBe(201);
        expect(await costFor(HANDLE)).toBe(50);

        // Buying stock does NOT put anything in a customer's vault, and a
        // handle nobody ever bought reads 0/0/0 + null cost rather than
        // undefined — Task 9 indexes both maps by handle.
        expect(await bucketsFor(HANDLE)).toEqual({
          inVault: 0,
          requested: 0,
          shipped: 0,
        });
        expect(await bucketsFor('never-touched-card')).toEqual({
          inVault: 0,
          requested: 0,
          shipped: 0,
        });
        expect(await costFor('never-touched-card')).toBeNull();

        // 2. PULL — seed a vaulted pull directly via the module service; the
        // roll path itself is out of scope for a bucket-math spec (same
        // rationale delivery-orders-bulk.spec.ts uses).
        const [pull] = await packs.createPulls([
          {
            customer_id: 'cus_lifecycle',
            pack_id: 'lifecycle-pack',
            card_id: HANDLE,
            rolled_at: new Date(),
            status: 'vaulted' as const,
            source: 'pack' as const,
          },
        ]);
        expect(await bucketsFor(HANDLE)).toEqual({
          inVault: 1,
          requested: 0,
          shipped: 0,
        });

        // 3. DELIVERY REQUEST. The real request path flips the pull
        // vaulted -> delivering in the SAME transaction that writes the order
        // and its item (workflows/steps/request-delivery.ts:153, and
        // recordRewardWithdrawal at service.ts:1609), so the card LEAVES the
        // vault bucket instead of sitting in two buckets at once. Seeding the
        // item WITHOUT that flip is an unreachable state, and it would let
        // this step pass with the vault query broken.
        const [order] = await packs.createDeliveryOrders([
          { customer_id: 'cus_lifecycle', status: 'requested', ...ADDRESS },
        ]);
        await packs.createDeliveryOrderItems([
          { delivery_order_id: order.id, pull_id: pull.id },
        ]);
        await packs.updatePulls([{ id: pull.id, status: 'delivering' }]);
        expect(await bucketsFor(HANDLE)).toEqual({
          inVault: 0,
          requested: 1,
          shipped: 0,
        });

        // The whole pre-ship pipeline is ONE bucket — not just 'requested'.
        for (const mid of ['processed', 'ready_to_ship'] as const) {
          await packs.updateDeliveryOrders([{ id: order.id, status: mid }]);
          expect(await bucketsFor(HANDLE)).toEqual({
            inVault: 0,
            requested: 1,
            shipped: 0,
          });
        }

        // 4. SHIPPED — the REAL (Epic-1-merged) enum. The pull itself stays
        // 'delivering' here; only the ORDER status moves the bucket.
        await packs.updateDeliveryOrders([
          { id: order.id, status: 'shipped', shipped_at: new Date() },
        ]);
        expect(await bucketsFor(HANDLE)).toEqual({
          inVault: 0,
          requested: 0,
          shipped: 1,
        });

        // 5. COMPLETED still counts as shipped, and the pull goes terminal
        // 'delivered' (transitionDeliveryOrderStatus's own side effect).
        await packs.updateDeliveryOrders([
          { id: order.id, status: 'completed', delivered_at: new Date() },
        ]);
        await packs.updatePulls([{ id: pull.id, status: 'delivered' }]);
        expect(await bucketsFor(HANDLE)).toEqual({
          inVault: 0,
          requested: 0,
          shipped: 1,
        });

        // Cost is a purchase fact — shipping the card away never rewrites it.
        expect(await costFor(HANDLE)).toBe(50);
      });

      it('a reversed purchase (net qty 0) reports null cost, not 0', async () => {
        const HANDLE = 'reversed-card';
        const line = (qty: number) => ({
          card_handle: HANDLE,
          card_name: 'Reversed Card',
          fmv_snapshot: 100,
          qty,
          unit_cost: 20,
        });

        const original = await buy([line(10)]);
        expect(original.status).toBe(201);
        // Discriminator: without this leg `toBeNull()` below passes just as
        // happily when the query returns NOTHING (wrong table, wrong column,
        // mangled placeholders) as when the net-zero guard fires.
        expect(await costFor(HANDLE)).toBe(20);

        const reversal = await buy(
          [line(-10)],
          original.data.invoice.id,
          '2026-07-29T00:00:00.000Z',
        );
        expect(reversal.status).toBe(201);
        expect(await costFor(HANDLE)).toBeNull();
      });

      it('listingCountByHandle sums distinct pack membership and rank-reward slots', async () => {
        const IN_PACKS = 'listing-packs-card';
        const IN_RANKS = 'listing-ranks-card';
        const IN_BOTH = 'listing-both-card';
        const IN_NEITHER = 'listing-none-card';

        await packs.createPackOdds([
          { pack_id: 'pack-a', card_id: IN_PACKS, rarity: 'Common', weight: 1 },
          { pack_id: 'pack-b', card_id: IN_PACKS, rarity: 'Common', weight: 1 },
          { pack_id: 'pack-a', card_id: IN_BOTH, rarity: 'Rare', weight: 1 },
          // A reward-pool entry (card_id NULL) must never be counted.
          {
            pack_id: 'pack-c',
            kind: 'credit' as const,
            credit_amount: 5,
            weight: 1,
          },
        ]);
        // Same json double-cast the production writer uses (service.ts:5122):
        // rank_rewards is model.json(), typed Record<string, unknown>.
        const stage = (stage_number: number, rewards: unknown[]) => ({
          stage_number,
          threshold_myr: 100 * stage_number,
          rank_rewards: rewards as unknown as Record<string, unknown>,
        });
        await packs.createChallengeStages([
          stage(1, [
            { rank: 1, card_id: IN_RANKS, credits: 0 },
            { rank: 2, card_id: IN_BOTH, credits: 0 },
            { rank: 3, card_id: null, credits: 5 },
          ]),
          stage(2, [{ rank: 1, card_id: IN_BOTH, credits: 0 }]),
        ]);

        const counts = await packs.listingCountByHandle([
          IN_PACKS,
          IN_RANKS,
          IN_BOTH,
          IN_NEITHER,
        ]);
        expect(counts.get(IN_PACKS)).toBe(2); // two packs, no rank rewards
        expect(counts.get(IN_RANKS)).toBe(1); // one rank reward, no packs
        expect(counts.get(IN_BOTH)).toBe(3); // one pack + two rank rewards
        expect(counts.get(IN_NEITHER)).toBe(0);
      });
    });
  },
});
