import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearFxDisplayCache } from '../../src/modules/packs/pricing';
import { clearPackListCache } from '../../src/api/store/packs/route';
import { clearAdminPackListCache } from '../../src/api/admin/packs/route';
import {
  compositionGroup,
  poolComposition,
} from '../../src/modules/packs/card-view';
import { pageAll } from '../../src/api/utils/page-all';
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
// Composition edges: an ALL-RAW pool (the `graded === 0` branch neither route
// asserted before) and an all-PSA-10 pool (the only pool the public catalog
// may flag `psa10` — PUB_PACK is all-graded but holds a PSA 9, the exact
// mis-entry that must NOT reach the "Guaranteed PSA 10" section).
const RAW_PACK = 'stats-raw-pack';
const PSA10_PACK = 'stats-psa10-pack';
// ACTIVE with no pool: the public catalog must list it with group null +
// psa10 false (EMPTY_PACK can't cover this — it is draft, so the store route
// filters it out entirely).
const ACTIVE_EMPTY_PACK = 'stats-active-empty-pack';
const PACK_PRICE = 300;
// NOT the same as pub_ev's RM74: at price 100 the pub_rtp assertion below would
// pass just as well against an implementation that dropped the division (or
// ignored the price entirely). 74/200 = 37% — exact, and distinguishable.
const PUB_PACK_PRICE = 200;

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
        // Both pack lists cache for 30s in MODULE state, which outlives the
        // per-test DB reset. This suite seeds through the module service (not
        // the write routes), so nothing busts them for us.
        clearAdminPackListCache();
        clearPackListCache();
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
          {
            slug: RAW_PACK,
            title: 'Stats Raw Pack',
            category: 'pokemon',
            price: 40,
            image: '/qa.png',
            status: 'active' as const,
            rank: 3,
          },
          {
            slug: PSA10_PACK,
            title: 'Stats PSA10 Pack',
            category: 'pokemon',
            price: 400,
            image: '/qa.png',
            status: 'active' as const,
            rank: 4,
          },
          {
            slug: ACTIVE_EMPTY_PACK,
            title: 'Stats Active Empty Pack',
            category: 'pokemon',
            price: 60,
            image: '/qa.png',
            status: 'active' as const,
            rank: 5,
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
          // RAW_PACK reuses the two raw cards; PSA10_PACK the two PSA 10s —
          // composition comes from the (pack, card) links, no new cards needed.
          {
            pack_id: RAW_PACK,
            card_id: 'stats-b',
            rarity: 'Rare' as const,
            locked: false,
            weight: 5000,
          },
          {
            pack_id: RAW_PACK,
            card_id: 'stats-c',
            rarity: 'Common' as const,
            locked: false,
            weight: 5000,
          },
          {
            pack_id: PSA10_PACK,
            card_id: 'stats-a',
            rarity: 'Legendary' as const,
            locked: false,
            weight: 5000,
          },
          {
            pack_id: PSA10_PACK,
            card_id: 'stats-legendary',
            rarity: 'Legendary' as const,
            locked: false,
            weight: 5000,
          },
        ]);
      });

      const list = (headers: Record<string, string>) =>
        unwrapResponse(api.get('/admin/packs', { headers }));

      const rowsOf = async (): Promise<
        Map<string, Record<string, unknown>>
      > => {
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
        // both graded ⇒ GRADED. An all-raw pool ⇒ RAW (not null). An empty
        // pool has nothing to infer ⇒ null.
        expect(rows.get(PACK)?.group).toBe('MIX');
        expect(rows.get(PUB_PACK)?.group).toBe('GRADED');
        expect(rows.get(RAW_PACK)?.group).toBe('RAW');
        expect(rows.get(EMPTY_PACK)?.group).toBeNull();
      });
      it('mirrors the composition on the public catalog (GET /store/packs)', async () => {
        // The store list cache is MODULE state and outlives the per-test DB
        // reset — clear it or this test reads a prior test's catalog.
        clearPackListCache();
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'stats-store-key',
          type: 'publishable',
          created_by: 'packs-list-stats',
        });
        const res = await unwrapResponse(
          api.get('/store/packs', {
            headers: { 'x-publishable-api-key': key.token },
          }),
        );
        expect(res.status).toBe(200);
        const rows = new Map(
          (
            res.data.packs as { slug: string; group: unknown; psa10: unknown }[]
          ).map((p) => [p.slug, p]),
        );
        expect(rows.get(PACK)?.group).toBe('MIX');
        expect(rows.get(PUB_PACK)?.group).toBe('GRADED');
        expect(rows.get(RAW_PACK)?.group).toBe('RAW');
        // EMPTY_PACK is draft — the public catalog must not list it at all.
        expect(rows.has(EMPTY_PACK)).toBe(false);
        // An ACTIVE empty pool is listed, with nothing to infer (null) and
        // never the guarantee.
        expect(rows.get(ACTIVE_EMPTY_PACK)?.group).toBeNull();
        expect(rows.get(ACTIVE_EMPTY_PACK)?.psa10).toBe(false);

        // The PSA 10 guarantee gate is STRICTER than GRADED: PUB_PACK is
        // all-graded but holds a PSA 9, so it must NOT be flagged psa10 —
        // only the all-PSA-10 pool may carry the storefront's guarantee.
        expect(rows.get(PSA10_PACK)?.group).toBe('GRADED');
        expect(rows.get(PSA10_PACK)?.psa10).toBe(true);
        expect(rows.get(PUB_PACK)?.psa10).toBe(false);
        expect(rows.get(PACK)?.psa10).toBe(false);
        expect(rows.get(RAW_PACK)?.psa10).toBe(false);
      });

      // The reward-row + orphan skip-set, end to end. GET /store/packs now
      // derives composition from a SQL aggregate while GET /admin/packs still
      // folds poolComposition in Node — this is the contract that keeps the two
      // implementations agreeing, and the guard for any future isGraded /
      // isPsa10 change.
      it('matches poolComposition across the reward-row and orphan skip-set', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const ZOO = 'stats-zoo-pack';
        // GUARD is all-PSA-10 ONLY once the skips apply: its reward row and its
        // orphaned RAW card would each drag psa10 to false (and group to MIX)
        // if either leaked into the pool, so the `psa10: true` assertion below
        // is what makes this case non-vacuous.
        const GUARD = 'stats-guard-pack';
        await packs.createPacks([
          {
            slug: ZOO,
            title: 'Stats Zoo Pack',
            category: 'pokemon',
            price: 100,
            image: '/qa.png',
            status: 'active' as const,
            rank: 6,
          },
          {
            slug: GUARD,
            title: 'Stats Guard Pack',
            category: 'pokemon',
            price: 100,
            image: '/qa.png',
            status: 'active' as const,
            rank: 7,
          },
        ]);
        // Both RAW on purpose — see GUARD above. `orphan` is HARD-deleted (the
        // row vanishes, so the join simply misses it); `softGone` is
        // SOFT-deleted, which is the only fixture that exercises the
        // `card.deleted_at IS NULL` scoping — a hard delete would pass even if
        // that clause were dropped.
        const [orphan, softGone] = await packs.createCards([
          {
            handle: 'stats-orphan',
            name: 'Stats Orphan',
            set: 'QA',
            grader: '',
            grade: '',
            market_value: 10,
            market_multiplier: 1,
            image: '/qa.png',
          },
          {
            handle: 'stats-softgone',
            name: 'Stats Soft Gone',
            set: 'QA',
            grader: '',
            grade: '',
            market_value: 10,
            market_multiplier: 1,
            image: '/qa.png',
          },
        ]);
        const rewardRow = (packId: string) =>
          ({
            pack_id: packId,
            card_id: null,
            rarity: null,
            // kind is REQUIRED on a card-less row (pack_odds_kind_payout_check).
            kind: 'nothing',
            locked: false,
            weight: 1000,
          }) as Parameters<typeof packs.createPackOdds>[0][number];
        await packs.createPackOdds([
          // ZOO's live pool: PSA 10 + PSA 9 + raw ⇒ MIX, never the guarantee.
          {
            pack_id: ZOO,
            card_id: 'stats-a',
            rarity: 'Legendary' as const,
            locked: false,
            weight: 1000,
          },
          {
            pack_id: ZOO,
            card_id: 'stats-common',
            rarity: 'Common' as const,
            locked: false,
            weight: 1000,
          },
          {
            pack_id: ZOO,
            card_id: 'stats-b',
            rarity: 'Rare' as const,
            locked: false,
            weight: 1000,
          },
          // GUARD's live pool: one PSA 10.
          {
            pack_id: GUARD,
            card_id: 'stats-a',
            rarity: 'Legendary' as const,
            locked: false,
            weight: 1000,
          },
          // Rows BOTH implementations must skip: reward entries (no card) and
          // rows whose card is deleted right below.
          rewardRow(ZOO),
          rewardRow(GUARD),
          {
            pack_id: ZOO,
            card_id: 'stats-orphan',
            rarity: 'Common' as const,
            locked: false,
            weight: 1000,
          },
          {
            pack_id: GUARD,
            card_id: 'stats-orphan',
            rarity: 'Common' as const,
            locked: false,
            weight: 1000,
          },
          {
            pack_id: ZOO,
            card_id: 'stats-softgone',
            rarity: 'Common' as const,
            locked: false,
            weight: 1000,
          },
          {
            pack_id: GUARD,
            card_id: 'stats-softgone',
            rarity: 'Common' as const,
            locked: false,
            weight: 1000,
          },
        ]);
        // Orphan them both ways: the cards go, their odds rows stay behind.
        await packs.deleteCards([orphan.id]);
        await packs.softDeleteCards([softGone.id]);
        clearPackListCache();
        clearAdminPackListCache();

        // Expected = poolComposition folded over the SAME rows the old code
        // path read, so this is a true A/B and not a restatement of the seed.
        const [allOdds, allCards] = await Promise.all([
          pageAll((opts) => packs.listPackOdds({}, opts)),
          pageAll((opts) => packs.listCards({}, opts)),
        ]);
        const comp = poolComposition(allOdds, allCards);
        // Non-vacuity: 6 seeded odds rows on ZOO, only 3 survive the skip-set
        // (and 4 on GUARD, only 1). A no-op delete or an uncounted reward row
        // fails right here, before either route is asked.
        expect(comp.get(ZOO)).toEqual({ total: 3, graded: 2, psa10: 1 });
        expect(comp.get(GUARD)).toEqual({ total: 1, graded: 1, psa10: 1 });

        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'stats-zoo-key',
          type: 'publishable',
          created_by: 'packs-list-stats',
        });
        const res = await unwrapResponse(
          api.get('/store/packs', {
            headers: { 'x-publishable-api-key': key.token },
          }),
        );
        expect(res.status).toBe(200);
        const store = new Map(
          (
            res.data.packs as { slug: string; group: unknown; psa10: unknown }[]
          ).map((p) => [p.slug, p]),
        );
        const admin = await rowsOf();

        for (const slug of [ZOO, GUARD]) {
          const t = comp.get(slug);
          expect(t).toBeDefined();
          const expectedGroup = compositionGroup(t!.graded, t!.total);
          expect(store.get(slug)?.group).toBe(expectedGroup);
          expect(store.get(slug)?.psa10).toBe(
            t!.total > 0 && t!.psa10 === t!.total,
          );
          expect(admin.get(slug)?.group).toBe(expectedGroup);
        }
        // Spelled out too, so a bug that made BOTH sides agree on the WRONG
        // number still fails.
        expect(store.get(ZOO)?.group).toBe('MIX');
        expect(store.get(ZOO)?.psa10).toBe(false);
        expect(store.get(GUARD)?.group).toBe('GRADED');
        expect(store.get(GUARD)?.psa10).toBe(true);
      });

      // This list caches for 30s, so every admin pack write has to bust it. The
      // odds editor is the sharpest case: the operator saves weights and goes
      // straight back to the list they came from to read the new EV.
      it('reflects an odds save immediately rather than serving the cached EV', async () => {
        // Populates the cache with the pre-edit numbers.
        expect((await rowsOf()).get(PACK)).toMatchObject({ ev: { s1: 170 } });

        // Common is the balancer, so pinning the two non-Common rows at 50/30
        // leaves stats-c (Common, RM100) absorbing the remaining 20%:
        // 0.5×300 + 0.3×200 + 0.2×100 = RM230.
        const saved = await unwrapResponse(
          api.post(
            `/admin/packs/${PACK}/odds`,
            {
              entries: [
                {
                  card_id: 'stats-a',
                  locked: false,
                  pct: 50,
                  rarity: 'Legendary',
                },
                { card_id: 'stats-b', locked: false, pct: 30, rarity: 'Rare' },
                { card_id: 'stats-c', locked: false, pct: 20, rarity: 'Common' },
              ],
            },
            { headers: { authorization: `Bearer ${adminToken}` } },
          ),
        );
        expect(saved.status).toBe(200);

        // Without the bust in the odds route this still reads the cached 170.
        expect((await rowsOf()).get(PACK)).toMatchObject({ ev: { s1: 230 } });
      });

      it('computes Published EV from the published tier percentages', async () => {
        const rows = await rowsOf();
        // 150 × 20% + 55 × 80% = 30 + 44 = RM74 promised on a RM200 pack ⇒ the
        // published odds advertise a 37% return.
        expect(rows.get(PUB_PACK)).toMatchObject({ pub_ev: 74, pub_rtp: 37 });
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
