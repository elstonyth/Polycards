import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import {
  recordPriceHistory,
  refreshCardPrice,
  type CardRow,
} from '../../src/modules/packs/sync-market-prices';
import { clearPackDetailCache } from '../../src/api/store/packs/[slug]/route';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'price-sync-history-pw-1';
const ADMIN_EMAIL = 'admin-price-sync-history@test.dev';
const PACK_SLUG = 'psh-pack';
const CARD_HANDLE = 'psh-card';
const FMV = 100;
const MULTIPLIER = 1.2;
const MANUAL_RATE = 4.0;

// The daily job's per-card seam (refreshCardPrice + recordPriceHistory) driven
// against the real DB, with only the PriceCharting HTTP call stubbed — the
// upstream response shape is the raw integer-pennies payload the job receives.
const pcFetchReturning =
  (pennies: number) =>
  async (): Promise<{ kind: 'ok'; data: Record<string, unknown> }> => ({
    kind: 'ok',
    data: { id: '6910', status: 'success', 'manual-only-price': pennies }, // PSA 10 field
  });

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('daily price sync — history trail + customer-surface propagation', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        clearPackDetailCache();
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'price-sync-history-test',
          type: 'publishable',
          created_by: 'price-sync-history-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Price Sync Test Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
            buyback_percent: 96,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Price Sync Test Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: FMV,
            market_multiplier: MULTIPLIER,
            image: '/cdn/test-card.webp',
            pc_product_id: '6910',
            pc_grade: 'PSA 10',
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

        const adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        const fxPost = await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            {
              manual_override: true,
              manual_rate: MANUAL_RATE,
              reason: 'test: pin FX for price-sync history',
            },
            { headers: { authorization: `Bearer ${adminToken}` } },
          ),
        );
        expect(fxPost.status).toBe(200);
      });

      const loadCard = async (): Promise<
        CardRow & { pc_synced_at: Date | null }
      > => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [card] = await packs.listCards(
          { handle: CARD_HANDLE },
          { take: 1 },
        );
        return card as unknown as CardRow & { pc_synced_at: Date | null };
      };

      // One sync tick, exactly as the job runs it (refresh then history).
      const syncTick = async (pennies: number, now: Date) => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const card = await loadCard();
        const r = await refreshCardPrice(card, {
          pcFetch: pcFetchReturning(pennies),
          updateCards: ([update]) => packs.applyCardPriceSync(card, update),
          now,
        });
        await recordPriceHistory(packs, card.id, r);
        return r;
      };

      const listHistory = async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const card = await loadCard();
        return packs.listCardPriceHistories(
          { card_id: card.id },
          { take: 100, order: { created_at: 'ASC' } },
        );
      };

      it('writes a history row per value change (baseline first, no dup on unchanged)', async () => {
        const now = new Date('2026-07-02T03:00:00Z');

        // Tick 1: $100 -> $200. Changed → history row.
        const r1 = await syncTick(20000, now);
        expect(r1.changed).toBe(true);
        expect(r1.newValue).toBe(200);

        let card = await loadCard();
        expect(Number(card.market_value)).toBe(200);
        expect(card.pc_synced_at).not.toBeNull();

        let history = await listHistory();
        expect(history).toHaveLength(1);
        expect(Number(history[0].value)).toBe(200);

        // Tick 2: same price. Unchanged → NO new row (but sync stamp advances).
        const later = new Date('2026-07-03T03:00:00Z');
        const r2 = await syncTick(20000, later);
        expect(r2.changed).toBe(false);
        expect(r2.skippedReason).toBeUndefined();
        history = await listHistory();
        expect(history).toHaveLength(1);

        // Tick 3: $200 -> $250. Changed → second row.
        const r3 = await syncTick(25000, new Date('2026-07-04T03:00:00Z'));
        expect(r3.changed).toBe(true);
        history = await listHistory();
        expect(history).toHaveLength(2);
        expect(Number(history[1].value)).toBe(250);

        card = await loadCard();
        expect(Number(card.market_value)).toBe(250);
      });

      it('writes a baseline row when the first sync returns an unchanged price', async () => {
        // Upstream agrees with the seeded FMV ($100): changed=false, but the
        // card has no history yet → one baseline row so the curve has a start.
        const r = await syncTick(10000, new Date('2026-07-02T03:00:00Z'));
        expect(r.changed).toBe(false);
        expect(r.skippedReason).toBeUndefined();

        const history = await listHistory();
        expect(history).toHaveLength(1);
        expect(Number(history[0].value)).toBe(100);
      });

      it('persists and confirms a large correction, then updates history and the customer price', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const before = await loadCard();
        await packs.updateCards([{ id: before.id, market_value: 875 }]);
        const first = await syncTick(4750, new Date('2026-10-16T03:00:00Z'));
        expect(first.changed).toBe(false);
        let card = await loadCard();
        expect(Number(card.market_value)).toBe(875);
        expect(card.pc_pending_price).toMatchObject({
          proposed_value: 47.5,
          baseline_value: 875,
        });
        expect(await listHistory()).toHaveLength(0);

        const confirmed = await syncTick(
          4750,
          new Date('2026-10-17T03:00:00Z'),
        );
        expect(confirmed.changed).toBe(true);
        card = await loadCard();
        expect(Number(card.market_value)).toBe(47.5);
        expect(card.pc_pending_price).toBeNull();
        const history = await listHistory();
        expect(history).toHaveLength(1);
        expect(Number(history[0].value)).toBe(47.5);
        clearPackDetailCache();
        const after = await unwrapResponse(
          api.get(`/store/packs/${PACK_SLUG}`, { headers: storeHeaders }),
        );
        expect(after.data.odds[0].marketPriceMyr).toBe(228);
      });

      it.each([
        {
          name: 'source and baseline',
          edit: {
            pc_product_id: '9999',
            market_value: 300,
            pc_pending_price: null,
          },
          pennies: 4750,
          hasPending: true,
        },
        {
          name: 'grade',
          edit: { pc_grade: 'Ungraded', pc_pending_price: null },
          pennies: 4750,
          hasPending: true,
        },
        {
          name: 'pending cancellation',
          edit: { pc_pending_price: null },
          pennies: 4750,
          hasPending: true,
        },
        {
          name: 'new pending observation',
          edit: { market_value: 300 },
          pennies: 4750,
          hasPending: false,
        },
        {
          name: 'invalid quote clearing',
          edit: { pc_product_id: '9999', pc_sync_error: 'new source error' },
          pennies: 0,
          hasPending: true,
        },
      ])(
        'does not overwrite a concurrent $name edit while the upstream request is in flight',
        async ({ edit, pennies, hasPending }) => {
          const packs =
            getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          const before = await loadCard();
          const pending = {
            product_id: '6910',
            grade: 'PSA 10',
            baseline_value: 875,
            proposed_value: 47.5,
            first_seen_at: '2026-10-16T03:00:00Z',
          };
          await packs.updateCards([
            {
              id: before.id,
              market_value: 875,
              pc_pending_price: hasPending ? pending : null,
            },
          ]);
          const observed = await loadCard();
          const result = await refreshCardPrice(observed, {
            pcFetch: async () => {
              await packs.updateCards([{ id: observed.id, ...edit }]);
              return pcFetchReturning(pennies)();
            },
            updateCards: ([update]) =>
              packs.applyCardPriceSync(observed, update),
            now: new Date('2026-10-17T03:00:00Z'),
          });
          await recordPriceHistory(packs, observed.id, result);
          expect(result).toMatchObject({
            changed: false,
            skippedReason: 'card changed during price check',
          });
          const current = await loadCard();
          expect(current).toMatchObject(edit);
          expect(Number(current.market_value)).toBe(
            'market_value' in edit ? edit.market_value : 875,
          );
          expect(await listHistory()).toHaveLength(0);
        },
      );

      it('only one concurrent confirmation can commit the same observed quote', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const before = await loadCard();
        await packs.updateCards([
          {
            id: before.id,
            market_value: 875,
            pc_pending_price: {
              product_id: '6910',
              grade: 'PSA 10',
              baseline_value: 875,
              proposed_value: 47.5,
              first_seen_at: '2026-10-16T03:00:00Z',
            },
          },
        ]);
        const observed = await loadCard();
        const results = await Promise.all(
          [1, 2].map(() =>
            refreshCardPrice(observed, {
              pcFetch: pcFetchReturning(4750),
              updateCards: ([update]) =>
                packs.applyCardPriceSync(observed, update),
              now: new Date('2026-10-17T03:00:00Z'),
            }),
          ),
        );
        expect(results.filter((r) => r.changed)).toHaveLength(1);
        expect(
          results.filter(
            (r) => r.skippedReason === 'card changed during price check',
          ),
        ).toHaveLength(1);
        expect(Number((await loadCard()).market_value)).toBe(47.5);
      });

      it('refreshed value reaches the customer pack detail (Top Hits) at request time', async () => {
        // Before the sync: marketPriceMyr = 100 × 4.0 × 1.2 = 480.
        const before = await unwrapResponse(
          api.get(`/store/packs/${PACK_SLUG}`, { headers: storeHeaders }),
        );
        expect(before.status).toBe(200);
        expect(before.data.odds).toHaveLength(1);
        expect(before.data.odds[0].market_value).toBe(FMV);
        expect(before.data.odds[0].marketPriceMyr).toBe(480);

        // Daily sync moves FMV to $200…
        await syncTick(20000, new Date('2026-07-02T03:00:00Z'));

        // …and the next request past the route's ≤30s per-process cache shows
        // 200 × 4.0 × 1.2 = 960. The first GET above populated that cache, so
        // clear it (as leaderboard.spec.ts does) to read the freshly-synced
        // price — this pins the compute, not the cache window.
        clearPackDetailCache();
        const after = await unwrapResponse(
          api.get(`/store/packs/${PACK_SLUG}`, { headers: storeHeaders }),
        );
        expect(after.data.odds[0].market_value).toBe(200);
        expect(after.data.odds[0].marketPriceMyr).toBe(960);
      });
    });
  },
});
