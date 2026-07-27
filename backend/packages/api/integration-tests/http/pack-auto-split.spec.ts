import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { proposeRarities, solveOddsForRtp } from '@acme/odds-math';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { packTheoreticalRtp } from '../../src/modules/packs/economy';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// What this proves that no @acme/odds-math unit test can: the solver's DECIMAL
// output survives coerceOddsEntries -> computeSetWeights -> balanceOdds ->
// integer bps storage and reads back at (approximately) the solved RTP. The
// smallest storable non-zero rate is 1 bps (MIN_PCT); if a floored row failed
// to survive that conversion it would round to 0 and the card would be
// PERMANENTLY UNWINNABLE — that can only be caught on this side of the API
// boundary, never inside odds-math's own pure-function tests.

const ADMIN_EMAIL = 'auto-split-admin@polycards.test';
const PASSWORD = 'supersecret-test-pw';
const PRICE = 50;

// Pins the USD_MYR rate via the same manual-override route fx-rate.spec.ts
// uses, matching what the real bronze-pack pool's fx_rate row carries (checked
// 2026-07-27). This is NOT cosmetic: resolveFxRate falls back to
// DEFAULT_USD_MYR (4.7) in a fresh test DB with no fx_rate row, and at 4.7 this
// exact CARDS list cannot hit a 70% target at all — solveOddsForRtp returns a
// band error, because even dumping 100% of the weight on the two Common cards
// (the cheapest in the pool) still yields ~73.3% RTP. Pinning the lower live
// rate is what makes "reproduce the bronze-pack shape" actually true here.
const FX_USD_MYR = 4.091;

// Card model default (Card.market_multiplier) at the time this fixture's
// expected RTP (below) was computed. Passed explicitly on every card so a
// later change to that default can't silently move this file's expected
// number out from under it — do NOT swap this for the imported constant.
const MARKET_MULTIPLIER = 1.2;

// Values here are RAW USD FMV, copied verbatim from the real bronze-pack
// pool's Card rows; the route converts each to a display price (FMV x fx x
// MARKET_MULTIPLIER) — see pricing.ts displayMarketPrice.
const CARDS = [
  { handle: 'as-pikachu', usd: 5 },
  { handle: 'as-bulbasaur', usd: 8 },
  { handle: 'as-jolteon', usd: 25 },
  { handle: 'as-gengar', usd: 120 },
  { handle: 'as-charizard', usd: 350 },
  { handle: 'as-dragonite', usd: 372.67 },
  { handle: 'as-mewtwo', usd: 900 },
  { handle: 'as-grey-felt', usd: 989.18 },
  { handle: 'as-pikachu-ex', usd: 990 },
  { handle: 'as-mega-charizard', usd: 2010 },
];

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('auto-split round trip', () => {
      let adminHeaders: Record<string, string>;
      let packs: PacksModuleService;

      beforeEach(async () => {
        const container = getContainer();
        const token = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);
        adminHeaders = { Authorization: `Bearer ${token}` };
        packs = container.resolve<PacksModuleService>(PACKS_MODULE);

        // Pin FX FIRST: resolveFxRate caches its result in-process for 30s, so
        // whichever route calls it first decides what every later display
        // price uses for the rest of this test. That must be this override,
        // not the 4.7 fallback.
        const fxSet = await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            {
              manual_override: true,
              manual_rate: FX_USD_MYR,
              reason: 'test: pin bronze-pack-shape fx for auto-split fixture',
            },
            { headers: adminHeaders },
          ),
        );
        expect(fxSet.status).toBe(200);

        await packs.createCards(
          CARDS.map((c) => ({
            handle: c.handle,
            name: c.handle,
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: c.usd,
            market_multiplier: MARKET_MULTIPLIER,
            image: '/cdn/test-card.webp',
          })),
        );

        const created = await unwrapResponse(
          api.post(
            '/admin/packs',
            {
              slug: 'auto-split-pack',
              title: 'Auto Split Pack',
              category: 'pokemon',
              price: PRICE,
              image: '/cdn/test-pack.webp',
              buyback_percent: 90,
              boost: false,
              rank: 0,
              status: 'draft',
            },
            { headers: adminHeaders },
          ),
        );
        expect(created.status).toBe(201);

        const members = await unwrapResponse(
          api.post(
            '/admin/packs/auto-split-pack/members',
            { card_ids: CARDS.map((c) => c.handle) },
            { headers: adminHeaders },
          ),
        );
        expect(members.status).toBe(200);
      });

      it('stored weights reproduce the solved (floored) RTP', async () => {
        const snapshot = await unwrapResponse(
          api.get('/admin/packs/auto-split-pack/odds', { headers: adminHeaders }),
        );
        expect(snapshot.status).toBe(200);

        const rows = snapshot.data.odds as {
          card_id: string;
          market_value: number;
          locked: boolean;
          pct: number;
        }[];

        // Mirrors the admin dashboard's autoSplit() (routes/packs/[slug]/page.tsx):
        // propose fresh value-banded rarities, then solve the chase budget for
        // the target RTP against those proposed tiers.
        const proposals = new Map(
          proposeRarities(
            rows.map((r) => ({ card_id: r.card_id, value: r.market_value })),
            PRICE,
          ).map((p) => [p.card_id, p.rarity]),
        );

        const solved = solveOddsForRtp(
          rows.map((r) => ({
            card_id: r.card_id,
            locked: r.locked,
            rarity: proposals.get(r.card_id) ?? 'Common',
            value: r.market_value,
            pct: r.pct,
          })),
          PRICE,
          0.7,
        );
        expect(solved.error).toBeNull();
        // The cascade re-solves after each floor, so the achieved RTP lands ON
        // the 70% target essentially exactly, BEFORE integer-bps storage — it
        // is the STORED rtp_pct (asserted below) that overshoots, not this
        // one. toBeCloseTo (not toBeGreaterThanOrEqual) because the raw value
        // is ~0.6999999999999998: an exact float, but epsilon-below 0.7.
        expect(solved.achievedRtp).toBeCloseTo(0.7, 6);
        // This fixture is only a meaningful regression guard if it actually
        // exercises the floor path (MIN_PCT in @acme/odds-math). Without this
        // premise check, `weight >= 1` below would still read green if a
        // future change to RARITY_WEIGHT/RARITY_BANDS/FX_USD_MYR stopped
        // anything from flooring — a pass that proves nothing, the same
        // failure shape as the a11y gate that reported 0 passes as clean.
        expect(solved.floored.length).toBeGreaterThan(0);

        const saved = await unwrapResponse(
          api.post(
            '/admin/packs/auto-split-pack/odds',
            {
              entries: solved.computed.map((c) => ({
                card_id: c.card_id,
                locked: false,
                pct: c.pct,
                rarity: proposals.get(c.card_id) ?? 'Common',
              })),
              target_rtp_bps: 7000,
            },
            { headers: adminHeaders },
          ),
        );
        expect(saved.status).toBe(200);

        const stored = await packs.listPackOdds(
          { pack_id: 'auto-split-pack' },
          { take: 50 },
        );
        expect(stored.reduce((s, o) => s + o.weight, 0)).toBe(10000);
        // The defect this whole test exists to catch: a floored 0.01% rate
        // that rounds down to 0 bps on the other side of the API boundary,
        // making that card permanently unwinnable.
        expect(stored.every((o) => o.weight >= 1)).toBe(true);

        const reread = await unwrapResponse(
          api.get('/admin/packs/auto-split-pack/odds', { headers: adminHeaders }),
        );
        const byId = new Map(
          (reread.data.odds as { card_id: string; market_value: number }[]).map((r) => [
            r.card_id,
            r.market_value,
          ]),
        );
        // PackOdds.card_id is nullable (reward-box rows carry null); this pack
        // was only ever given card entries via /members, so a null card_id
        // here would be a genuine anomaly, not something to cast/assert past.
        // Narrow with the same filter GET .../odds/route.ts uses, then fail
        // loudly if that ever drops a row instead of silently under-counting.
        const cardRows = stored.filter(
          (o): o is typeof o & { card_id: string } => o.card_id != null,
        );
        expect(cardRows.length).toBe(stored.length);
        // OddsValue's field is `market_value` (not `fmv`) and PackRtp returns
        // `rtp_pct` as a PERCENTAGE — verified against economy.ts.
        const rtp = packTheoreticalRtp(
          cardRows.map((o) => ({
            weight: o.weight,
            market_value: byId.get(o.card_id) ?? 0,
          })),
          PRICE,
        );
        expect(rtp).not.toBeNull();
        // Expected value computed by running this exact fixture (CARDS/PRICE/
        // FX_USD_MYR above) through the real pipeline once: raw unrounded
        // 70.267268%, which packTheoreticalRtp rounds to 70.27 — matching
        // task-6-report.md's independent LIVE verification of this same pool
        // ("RM 35.13 . 70.27%") to the hundredth. Not forced to any number;
        // tolerance (2 decimal digits => +/-0.005) only absorbs float-path
        // noise between this derivation and a real run, not drift.
        expect(rtp!.rtp_pct).toBeCloseTo(70.27, 2);
        // The real invariant, independent of the exact numbers above:
        // per-row integer-bps rounding of the (small) chase rates can only
        // ever shift weight AWAY from the Common absorbers — the cheapest
        // cards in the pool — toward the pricier chase tier, since Common
        // gets whatever bps is left over rather than its own independently
        // rounded share. That can only push realized RTP UP relative to the
        // pre-rounding achieved RTP, never down.
        expect(rtp!.rtp_pct).toBeGreaterThanOrEqual((solved.achievedRtp ?? 0) * 100);
      });
    });
  },
});
