import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { seedOf } from '../../src/utils/profile-handle';
import { clearLeaderboardCache } from '../../src/api/store/leaderboard/route';
import { myrDisplay as MYR, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// The leaderboard is aggregated in the DB (GROUP BY + ORDER BY + LIMIT). These
// pin the REAL-TRANSACTION contract on both aggregates (Weekly Pulled Value
// Challenge standard, 2026-07-19):
//   - weekly  = pulled VALUE over the challenge-anchored week (challengeWeekTop,
//     the SAME board /task shows). `points` mirrors `volume` on this board — the
//     wire shape needs a finite points field and the weekly UI renders volume.
//     Independent of pack PRICE and immune to credit reversals (both only move
//     spend); `volume` is the won cards' MYR display value.
//   - alltime = REAL spend from the credit ledger's pack_open debits
//     (points = spend × 100) — NOT re-joined to the pack's CURRENT price, and a
//     reversal (positive mirror row) nets it back out.
// Also pinned: value/points-desc ordering, top-N truncation, and each
// aggregate's window. `volume` = market_value × multiplier × FX; reward-box
// draws excluded on both paths.

const PACK_A = 'lb-a'; // price 10
const PACK_B = 'lb-b'; // price 20
const CARD_X = 'lb-x'; // mv 50 USD
const CARD_Y = 'lb-y'; // mv 30 USD
const DAY_MS = 24 * 60 * 60 * 1000;

// No FxRate row is seeded and cards carry the model-default multiplier, so
// the MYR winnings column follows the shared myrDisplay helper (see utils).

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('leaderboard aggregation', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        // The route's per-process 30s board cache outlives each test's
        // fixtures (one jest process = one module instance) — clear it so a
        // previous test's board is never served against this test's data.
        clearLeaderboardCache();

        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'leaderboard-test',
          type: 'publishable',
          created_by: 'leaderboard-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_A,
            title: 'LB Pack A',
            category: 'pokemon',
            price: 10,
            image: '/x.webp',
          },
          {
            slug: PACK_B,
            title: 'LB Pack B',
            category: 'pokemon',
            price: 20,
            image: '/x.webp',
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_X,
            name: 'X',
            set: 'S',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            image: '/x.webp',
          },
          {
            handle: CARD_Y,
            name: 'Y',
            set: 'S',
            grader: 'PSA',
            grade: '10',
            market_value: 30,
            image: '/x.webp',
          },
        ]);

        const now = new Date();
        const old = new Date(Date.now() - 8 * DAY_MS); // outside the 7-day window
        const pulls = (
          customer_id: string,
          pack_id: string,
          card_id: string,
          rolled_at: Date,
          n: number,
        ) =>
          Array.from({ length: n }, () => ({
            customer_id,
            pack_id,
            card_id,
            rolled_at,
          }));
        // One pack_open debit per open — the same rows the charge step writes.
        const charges = (
          customer_id: string,
          price: number,
          created_at: Date,
          n: number,
        ) =>
          Array.from({ length: n }, () => ({
            customer_id,
            amount: -price,
            reason: 'pack_open' as const,
            created_at,
          }));

        // Pulls carry NO recorded_value_usd, so the weekly aggregate exercises
        // the live-pricing COALESCE fallback (market_value × multiplier). Per
        // customer: spend (alltime points) | pulled value USD (weekly volume).
        await packs.createPulls([
          // C3: 3 × packB+cardX → spend 60 (points 6000) | 3×50 = 150 USD (recent)
          ...pulls('cus_lb_3', PACK_B, CARD_X, now, 3),
          // C1: 2 × packA+cardX → spend 20 (points 2000) | 100 USD (recent)
          ...pulls('cus_lb_1', PACK_A, CARD_X, now, 2),
          // C2: 1 × packB+cardY → spend 20 (points 2000) | 30 USD (recent)
          ...pulls('cus_lb_2', PACK_B, CARD_Y, now, 1),
          // C4: 5 × packB+cardX OLD → spend 100 (alltime #1; outside the week)
          ...pulls('cus_lb_4', PACK_B, CARD_X, old, 5),
        ]);
        await packs.createCreditTransactions([
          ...charges('cus_lb_3', 20, now, 3),
          ...charges('cus_lb_1', 10, now, 2),
          ...charges('cus_lb_2', 20, now, 1),
          ...charges('cus_lb_4', 20, old, 5),
        ] as Parameters<typeof packs.createCreditTransactions>[0]);
      });

      const board = (period?: string) =>
        unwrapResponse(
          api.get(`/store/leaderboard${period ? `?period=${period}` : ''}`, {
            headers: storeHeaders,
          }),
        ).then((r) => r.data.entries as Array<Record<string, number>>);

      it('ranks the weekly window by pulled value (points mirrors volume)', async () => {
        const entries = await board(); // default = weekly
        expect(entries).toHaveLength(3); // C4's old pulls fall outside the week

        // Ranked by pulled value DESC: C3 (150 USD) > C1 (100) > C2 (30).
        // challengeWeekTop's tie-break is customer_id ASC (no tie here).
        expect(entries.map((e) => e.seed)).toEqual([
          seedOf('cus_lb_3'),
          seedOf('cus_lb_1'),
          seedOf('cus_lb_2'),
        ]);
        expect(entries[0]).toMatchObject({
          rank: 1,
          points: MYR(150),
          volume: MYR(150),
          pulls: 3,
        });
        expect(entries[1]).toMatchObject({
          rank: 2,
          points: MYR(100),
          volume: MYR(100),
          pulls: 2,
        });
        expect(entries[2]).toMatchObject({
          rank: 3,
          points: MYR(30),
          volume: MYR(30),
          pulls: 1,
        });
      });

      // An admin disable must take the player off the PUBLIC board, on both
      // periods. Their pull/spend rows are untouched (a disable is reversible,
      // so nothing is confiscated) — this is a display filter, and the
      // survivors are re-numbered 1..N because a gap in the ranks would itself
      // publish that someone was removed.
      it('hides an administratively disabled player and re-numbers the ranks', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.setAccountDisabled({
          customerId: 'cus_lb_1',
          adminId: 'user_lb_admin',
          disabled: true,
          reason: 'test disable',
        });

        const weekly = await board();
        expect(weekly.map((e) => e.seed)).toEqual([
          seedOf('cus_lb_3'),
          seedOf('cus_lb_2'),
        ]);
        expect(weekly.map((e) => e.rank)).toEqual([1, 2]);

        const alltime = await board('alltime');
        expect(alltime.map((e) => e.seed)).not.toContain(seedOf('cus_lb_1'));
        expect(alltime.map((e) => e.rank)).toEqual([1, 2, 3]);
      });

      it('all-time includes the old spend and ranks it #1', async () => {
        const entries = await board('alltime');
        expect(entries).toHaveLength(4);
        expect(entries[0]).toMatchObject({
          seed: seedOf('cus_lb_4'),
          rank: 1,
          points: 10000,
          volume: MYR(250),
          pulls: 5,
        });
      });

      it('repricing a pack does NOT move the weekly (pulled-value) board', async () => {
        const container = getContainer();
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        // Weekly ranks by pulled value (card FMV × multiplier × FX), which is
        // independent of pack PRICE — repricing pack A to 1000 must not move it
        // (nor change any points/volume figure, since neither reads pack price).
        const [packA] = await packs.listPacks({ slug: PACK_A }, { take: 1 });
        await packs.updatePacks([{ id: packA.id, price: 1000 }]);

        const entries = await board();
        expect(entries.map((e) => e.seed)).toEqual([
          seedOf('cus_lb_3'),
          seedOf('cus_lb_1'),
          seedOf('cus_lb_2'),
        ]);
        expect(entries[1]).toMatchObject({
          points: MYR(100),
          volume: MYR(100),
        });
      });

      it('all-time spend nets out a reversed open and re-ranks', async () => {
        const container = getContainer();
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        // all-time ranks by immutable ledger spend. A reversal is a POSITIVE
        // mirror row with the same 'pack_open' reason, so C1 nets 2000 → 1000
        // and falls below C2's intact 2000.
        await packs.createCreditTransactions([
          { customer_id: 'cus_lb_1', amount: 10, reason: 'pack_open' },
        ] as Parameters<typeof packs.createCreditTransactions>[0]);
        // The board is deliberately ≤30s stale (per-process cache) — this
        // test pins the ranking METRIC, so read past the cache.
        clearLeaderboardCache();

        const entries = await board('alltime');
        // C4 (10000) > C3 (6000) > C2 (2000) > C1 (1000, after reversal).
        expect(entries.map((e) => e.seed)).toEqual([
          seedOf('cus_lb_4'),
          seedOf('cus_lb_3'),
          seedOf('cus_lb_2'),
          seedOf('cus_lb_1'),
        ]);
        expect(entries[3]).toMatchObject({ points: 1000 });
      });

      // GET /store/leaderboard/me — the caller's OWN weekly figure, which the
      // storefront subtracts from a board row to say "RM x to top 10". The
      // board itself is a top-10 slice, so a player below it has no row there;
      // this is the only surface that can answer for them.
      describe('own weekly standing', () => {
        const PASSWORD = 'supersecret';

        const authed = (token: string): Record<string, string> => ({
          ...storeHeaders,
          authorization: `Bearer ${token}`,
        });

        // The register JWT carries actor_id: '' until POST /store/customers
        // links it — log in AGAIN afterwards, or the route reads an empty
        // customer id and every assertion below passes vacuously.
        const registerCustomer = async (
          email: string,
        ): Promise<{ token: string; id: string }> => {
          const reg = await api.post('/auth/customer/emailpass/register', {
            email,
            password: PASSWORD,
          });
          await api.post(
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
          const token = login.data.token as string;
          const me = await unwrapResponse(
            api.get('/store/customers/me', { headers: authed(token) }),
          );
          const id = me.data.customer.id as string;
          expect(id).toBeTruthy();
          return { token, id };
        };

        const own = (token: string) =>
          unwrapResponse(
            api.get('/store/leaderboard/me', { headers: authed(token) }),
          );

        it('rejects an unauthenticated caller with 401', async () => {
          // The sibling board is deliberately public; this sub-path is not.
          const res = await unwrapResponse(
            api.get('/store/leaderboard/me', { headers: storeHeaders }),
          );
          expect(res.status).toBe(401);
        });

        it('answers 0/0 for a customer who has not pulled this week', async () => {
          const { token, id } = await registerCustomer('lb-me-empty@test.dev');
          const res = await own(token);
          expect(res.status).toBe(200);
          expect(res.data).toEqual({ volume: 0, pulls: 0, seed: seedOf(id) });
        });

        it('answers the caller’s own weekly value, excluding reward pulls and last week', async () => {
          const { token, id } = await registerCustomer('lb-me@test.dev');
          const packs =
            getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          await packs.createPulls([
            // 2 × cardX (50 USD each) inside the week → 100 USD.
            {
              customer_id: id,
              pack_id: PACK_A,
              card_id: CARD_X,
              rolled_at: new Date(),
            },
            {
              customer_id: id,
              pack_id: PACK_A,
              card_id: CARD_X,
              rolled_at: new Date(),
            },
            // A reward-box draw: never counts toward the board, so it must not
            // count here either — otherwise the gap is measured against a
            // figure the board never saw.
            {
              customer_id: id,
              pack_id: 'reward-box-bronze',
              card_id: CARD_X,
              rolled_at: new Date(),
              source: 'reward',
            },
            // Outside the challenge week.
            {
              customer_id: id,
              pack_id: PACK_A,
              card_id: CARD_X,
              rolled_at: new Date(Date.now() - 8 * DAY_MS),
            },
          ] as Parameters<typeof packs.createPulls>[0]);

          const res = await own(token);
          expect(res.status).toBe(200);
          // The seed is how the storefront finds this caller's own row on the
          // public board: a handle is assigned lazily on first render, so for
          // one board window a genuine top-10 row carries handle: null and
          // matches nobody. Same value the board already publishes per row.
          expect(res.data).toEqual({
            volume: MYR(100),
            pulls: 2,
            seed: seedOf(id),
          });

          // And it agrees with the row the public board publishes for them —
          // the gap the storefront renders is a subtraction across these two
          // responses, so a drift here quotes a distance to a differently
          // measured row.
          clearLeaderboardCache();
          const entries = await board();
          const mine = entries.find((e) => e.seed === seedOf(id));
          expect(mine).toMatchObject({ volume: MYR(100), pulls: 2 });
        });

        it('is not cached across callers', async () => {
          const a = await registerCustomer('lb-me-a@test.dev');
          const b = await registerCustomer('lb-me-b@test.dev');
          const packs =
            getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          await packs.createPulls([
            {
              customer_id: a.id,
              pack_id: PACK_A,
              card_id: CARD_X,
              rolled_at: new Date(),
            },
          ] as Parameters<typeof packs.createPulls>[0]);

          // B reading straight after A must see B's own zero, not A's board
          // figure — the whole reason this lives outside the cached board.
          expect((await own(a.token)).data).toEqual({
            volume: MYR(50),
            pulls: 1,
            seed: seedOf(a.id),
          });
          expect((await own(b.token)).data).toEqual({
            volume: 0,
            pulls: 0,
            seed: seedOf(b.id),
          });
        });
      });
    });
  },
});
