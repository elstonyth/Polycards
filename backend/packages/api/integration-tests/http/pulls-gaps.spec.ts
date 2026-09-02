import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearPullGapsCache } from '../../src/api/store/pulls/gaps/route';
import { clearRecentPullsCache } from '../../src/api/store/pulls/recent/route';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GET /store/pulls/gaps — the stats chart behind the pull-history panel. The
// gap arithmetic is a window function over the scope's whole ledger, so it is
// pinned end to end: numbered in roll order, each hit's gap counts from the
// previous hit (the first from the ledger's start), `current` is the pulls
// since the newest hit, and the header rate comes from the pack's PUBLISHED
// odds (null on the global feed).
const PACK = 'gaps-pack';
const COMMON = 'gaps-common';
const IMMORTAL = 'gaps-immortal';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('store pull gaps — hit history for the stats chart', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        clearPullGapsCache();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'gaps-test',
          type: 'publishable',
          created_by: 'gaps-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK,
            title: 'Gaps Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/gaps-pack.webp',
            published_odds: { tiers: { Immortal: 1.1, Common: 98.9 } },
          } as Parameters<typeof packs.createPacks>[0][number],
        ]);
        await packs.createCards([
          {
            handle: COMMON,
            name: 'Common Card',
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: 5,
            image: 'common.png',
          },
          {
            handle: IMMORTAL,
            name: 'Immortal Card',
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: 500,
            image: 'immortal.png',
          },
        ]);
        await packs.createPackOdds([
          { pack_id: PACK, card_id: COMMON, rarity: 'Common', weight: 99 },
          { pack_id: PACK, card_id: IMMORTAL, rarity: 'Immortal', weight: 1 },
        ]);
        // Roll order: C C I C C C I C  → hits at #3 (gap 3) and #7 (gap 4),
        // then one pull since → current 1.
        const order = [
          COMMON,
          COMMON,
          IMMORTAL,
          COMMON,
          COMMON,
          COMMON,
          IMMORTAL,
          COMMON,
        ];
        const t0 = Date.now() - 60_000;
        await packs.createPulls(
          order.map((card, i) => ({
            customer_id: 'cus_gaps',
            pack_id: PACK,
            card_id: card,
            order_id: null,
            rolled_at: new Date(t0 + i * 1_000),
            source: 'pack' as const,
          })),
        );
      });

      it('numbers the ledger, gaps each hit from the previous one, and reads the published rate', async () => {
        const r = await unwrapResponse(
          api.get(`/store/pulls/gaps?pack_id=${PACK}&rarity=Immortal`, {
            headers: storeHeaders,
          }),
        );
        expect(r.status).toBe(200);
        expect(r.data.rarity).toBe('Immortal');
        // Newest hit first.
        expect(r.data.hits.map((h: { gap: number }) => h.gap)).toEqual([4, 3]);
        expect(r.data.current).toBe(1);
        expect(r.data.avg).toBeCloseTo(3.5);
        expect(r.data.last20).toBeCloseTo(3.5);
        // 1.1% published → one hit every 91 draws.
        expect(r.data.pct).toBeCloseTo(1.1);
        expect(r.data.expected).toBe(91);
        // Display fields ride each hit (no customer record → anonymous, seeded).
        expect(r.data.hits[0]).toMatchObject({
          who: 'Anonymous',
          profile_handle: null,
          avatar_url: null,
          frame_url: null,
        });
        expect(typeof r.data.hits[0].seed).toBe('number');

        // A tier with no hits: no gaps, the whole ledger is the drought.
        const legendary = await unwrapResponse(
          api.get(`/store/pulls/gaps?pack_id=${PACK}&rarity=Legendary`, {
            headers: storeHeaders,
          }),
        );
        expect(legendary.status).toBe(200);
        expect(legendary.data.hits).toEqual([]);
        expect(legendary.data.current).toBe(8);
        expect(legendary.data.avg).toBeNull();
        expect(legendary.data.pct).toBeNull();
        expect(legendary.data.expected).toBeNull();

        // Global scope: same gaps, but no pack means no published rate.
        const globalImmortal = await unwrapResponse(
          api.get('/store/pulls/gaps?rarity=Immortal', {
            headers: storeHeaders,
          }),
        );
        expect(globalImmortal.status).toBe(200);
        expect(
          globalImmortal.data.hits.map((h: { gap: number }) => h.gap),
        ).toEqual([4, 3]);
        expect(globalImmortal.data.pct).toBeNull();
        expect(globalImmortal.data.expected).toBeNull();

        // A draft / unknown pack answers the empty chart before any ledger
        // scan — and never leaks its published rate.
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: `${PACK}-draft`,
            title: 'Draft Gaps Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/draft.webp',
            status: 'draft',
            published_odds: { tiers: { Immortal: 5 } },
          } as Parameters<typeof packs.createPacks>[0][number],
        ]);
        for (const slug of [`${PACK}-draft`, 'no-such-pack']) {
          const r = await unwrapResponse(
            api.get(`/store/pulls/gaps?pack_id=${slug}&rarity=Immortal`, {
              headers: storeHeaders,
            }),
          );
          expect(r.status).toBe(200);
          expect(r.data).toEqual({
            rarity: 'Immortal',
            pct: null,
            expected: null,
            avg: null,
            last20: null,
            current: 0,
            hits: [],
          });
        }

        // A batch open stamps its cards with ONE rolled_at. The chart's drought
        // bar and the feed's drought counter must still agree on "pulls since
        // the last hit" — both count in (rolled_at, id) order.
        const tBatch = new Date();
        await packs.createPulls(
          [IMMORTAL, COMMON, COMMON].map((card) => ({
            customer_id: 'cus_gaps',
            pack_id: PACK,
            card_id: card,
            order_id: null,
            rolled_at: tBatch,
            source: 'pack' as const,
          })),
        );
        clearPullGapsCache();
        clearRecentPullsCache();
        const [afterBatch, feed] = await Promise.all([
          unwrapResponse(
            api.get(`/store/pulls/gaps?pack_id=${PACK}&rarity=Immortal`, {
              headers: storeHeaders,
            }),
          ),
          unwrapResponse(
            api.get(`/store/pulls/recent?pack_id=${PACK}`, {
              headers: storeHeaders,
            }),
          ),
        ]);
        expect(afterBatch.data.hits).toHaveLength(3);
        expect(afterBatch.data.current).toBe(feed.data.drought.Immortal);
        // Whatever the id order inside the batch, the three new rows land as
        // one hit plus its trailing drought: gap + current = 3 + the one pull
        // (#8) that followed the previous hit.
        expect(afterBatch.data.hits[0].gap + afterBatch.data.current).toBe(4);

        // A disabled player's hits STAY (dropping one would corrupt the
        // neighbouring gaps) but are anonymised — no name, face or handle.
        await packs.setAccountDisabled({
          customerId: 'cus_gaps',
          adminId: 'user_gaps_admin',
          disabled: true,
          reason: 'test disable',
        });
        clearPullGapsCache();
        const anon = await unwrapResponse(
          api.get(`/store/pulls/gaps?pack_id=${PACK}&rarity=Immortal`, {
            headers: storeHeaders,
          }),
        );
        expect(anon.data.hits).toHaveLength(3);
        for (const hit of anon.data.hits) {
          expect(hit).toMatchObject({
            who: 'Anonymous',
            seed: null,
            profile_handle: null,
            avatar_url: null,
            frame_url: null,
          });
        }
      });
    });
  },
});
