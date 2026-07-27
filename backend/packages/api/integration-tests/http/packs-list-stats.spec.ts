import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearFxDisplayCache } from '../../src/modules/packs/pricing';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// POLYCARD-BACK §2.3 — GET /admin/packs carries the operator's decision numbers:
// per-odds-set EV/RTP, the PUBLISHED EV (what players are promised) and the
// auto-detected RAW/GRADED composition.
//
// Every number here is EXACT by construction, not approximately right:
//   fx pinned to 1 and every card's market_multiplier pinned to 1, so a card's
//   PRICE (FMV × fx × multiplier) equals its seeded FMV. The spec's worked
//   example then lands on whole ringgit.
//
//   card   price   weight (set 1)   weight_2 (set 2)   weight_3
//   a       300         2000              5000           NULL
//   b       200         3000              3000           NULL
//   c       100         5000              2000           NULL
//
// Set 1 EV = 0.2×300 + 0.3×200 + 0.5×100 = RM170 (RTP 170/300 = 56.67%).
// Set 2 EV = 0.5×300 + 0.3×200 + 0.2×100 = RM230 — a DIFFERENT number from the
// same pool, which is the whole point of the per-set columns. weight_3 is NULL
// on every row, so set 3 INHERITS set 2 (weightForSet's 3→2→1 fallback) and
// must report 230 too — an s3 of 170 would mean the fallback was skipped.

const PACK = 'stats-pack';
const PUB_PACK = 'stats-pub-pack';
const EMPTY_PACK = 'stats-empty-pack';
const PACK_PRICE = 300;
const PUB_PACK_PRICE = 100;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin packs list — per-set EV/RTP, published EV, group', () => {
      let adminToken: string;

      beforeEach(async () => {
        // The display FX rate is cached for 30s in MODULE state, which outlives
        // this suite's per-test DB reset — a rate cached before the FxRate row
        // below existed would silently reprice every card at the 4.7 fallback.
        clearFxDisplayCache();
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'packs-stats-admin@test.dev',
          'packs-stats-password-1',
        );

        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: 1,
            source: 'test',
            manual_override: true,
            manual_rate: 1,
          },
        ]);
        await packs.createPacks([
          {
            slug: PACK,
            title: 'Stats Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/qa.png',
            status: 'active' as const,
            rank: 0,
          },
          {
            // Published odds are PLAYER-FACING display data — this pack proves
            // Published EV is folded over them, not over the secret weights.
            slug: PUB_PACK,
            title: 'Stats Published Pack',
            category: 'pokemon',
            price: PUB_PACK_PRICE,
            image: '/qa.png',
            status: 'active' as const,
            rank: 1,
            published_odds: {
              overall: 100,
              tiers: { Legendary: 20, Common: 80 },
            },
          },
          {
            // No pool at all: every stat must be null, never 0 or 'RAW'.
            slug: EMPTY_PACK,
            title: 'Stats Empty Pack',
            category: 'pokemon',
            price: 50,
            image: '/qa.png',
            status: 'draft' as const,
            rank: 2,
          },
        ]);
        // grader/grade are NOT NULL columns; '' is how a RAW card is stored.
        // Exactly one graded card in PACK ⇒ the composition must read MIX.
        await packs.createCards([
          {
            handle: 'stats-a',
            name: 'Stats A',
            set: 'QA',
            grader: 'PSA',
            grade: '10',
            market_value: 300,
            market_multiplier: 1,
            image: '/qa.png',
          },
          {
            handle: 'stats-b',
            name: 'Stats B',
            set: 'QA',
            grader: '',
            grade: '',
            market_value: 200,
            market_multiplier: 1,
            image: '/qa.png',
          },
          {
            handle: 'stats-c',
            name: 'Stats C',
            set: 'QA',
            grader: '',
            grade: '',
            market_value: 100,
            market_multiplier: 1,
            image: '/qa.png',
          },
          {
            handle: 'stats-legendary',
            name: 'Stats Legendary',
            set: 'QA',
            grader: 'PSA',
            grade: '10',
            market_value: 150,
            market_multiplier: 1,
            image: '/qa.png',
          },
          {
            handle: 'stats-common',
            name: 'Stats Common',
            set: 'QA',
            grader: 'PSA',
            grade: '9',
            market_value: 55,
            market_multiplier: 1,
            image: '/qa.png',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK,
            card_id: 'stats-a',
            rarity: 'Legendary' as const,
            locked: false,
            weight: 2000,
            weight_2: 5000,
          },
          {
            pack_id: PACK,
            card_id: 'stats-b',
            rarity: 'Rare' as const,
            locked: false,
            weight: 3000,
            weight_2: 3000,
          },
          {
            pack_id: PACK,
            card_id: 'stats-c',
            rarity: 'Common' as const,
            locked: false,
            weight: 5000,
            weight_2: 2000,
          },
          // PUB_PACK: one card per published tier, so the tier price averages
          // are the card prices themselves (150 and 55).
          {
            pack_id: PUB_PACK,
            card_id: 'stats-legendary',
            rarity: 'Legendary' as const,
            locked: false,
            weight: 1000,
          },
          {
            pack_id: PUB_PACK,
            card_id: 'stats-common',
            rarity: 'Common' as const,
            locked: false,
            weight: 9000,
          },
        ]);
      });

      const list = (headers: Record<string, string>) =>
        unwrapResponse(api.get('/admin/packs', { headers }));

      const rowsOf = async (): Promise<Map<string, Record<string, unknown>>> => {
        const res = await list({ authorization: `Bearer ${adminToken}` });
        expect(res.status).toBe(200);
        const packs = res.data.packs as Record<string, unknown>[];
        return new Map(packs.map((p) => [p.slug as string, p]));
      };

      it('rejects an unauthenticated read with 401', async () => {
        expect((await list({})).status).toBe(401);
      });

      it('reports per-set EV/RTP on DISPLAY prices, with set 3 inheriting set 2', async () => {
        const pack = (await rowsOf()).get(PACK);
        // Assert the pack resolved before reading through it — a missing row
        // would make every `?.` assertion below pass against undefined.
        expect(pack).toBeDefined();
        expect(pack).toMatchObject({
          ev: { s1: 170, s2: 230, s3: 230 },
          rtp: { s1: 56.67, s2: 76.67, s3: 76.67 },
        });
      });

      it('auto-detects the pack composition from its pool', async () => {
        const rows = await rowsOf();
        // stats-a is PSA, stats-b/c are raw ⇒ MIX. PUB_PACK's two cards are
        // both graded ⇒ GRADED. An empty pool has nothing to infer ⇒ null.
        expect(rows.get(PACK)?.group).toBe('MIX');
        expect(rows.get(PUB_PACK)?.group).toBe('GRADED');
        expect(rows.get(EMPTY_PACK)?.group).toBeNull();
      });

      it('computes Published EV from the published tier percentages', async () => {
        const rows = await rowsOf();
        // 150 × 20% + 55 × 80% = 30 + 44 = RM74 on a RM100 pack.
        expect(rows.get(PUB_PACK)).toMatchObject({ pub_ev: 74, pub_rtp: 74 });
        // No published odds at all ⇒ nothing was promised ⇒ null, not 0.
        expect(rows.get(PACK)).toMatchObject({ pub_ev: null, pub_rtp: null });
      });

      it('nulls every stat for a pack with an empty pool', async () => {
        expect(await rowsOf().then((r) => r.get(EMPTY_PACK))).toMatchObject({
          ev: { s1: null, s2: null, s3: null },
          rtp: { s1: null, s2: null, s3: null },
          pub_ev: null,
          pub_rtp: null,
          group: null,
        });
      });
    });
  },
});
