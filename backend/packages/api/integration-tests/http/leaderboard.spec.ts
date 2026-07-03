import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { seedOf } from '../../src/utils/profile-handle';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// The leaderboard is aggregated in the DB (GROUP BY + ORDER BY + LIMIT). These
// pin the REAL-TRANSACTION contract: ranking comes from the credit ledger's
// pack_open debits (points = spend × 100) — NOT from re-joining pulls to the
// pack's CURRENT price — and `volume` (winnings) is the won cards' MYR display
// value (market_value × multiplier × FX), matching every other money surface.
// Also pinned: points-desc ordering with a deterministic tie-break, top-N
// truncation, and the weekly window on both aggregates.

const PACK_A = 'lb-a'; // price 10
const PACK_B = 'lb-b'; // price 20
const CARD_X = 'lb-x'; // mv 50 USD
const CARD_Y = 'lb-y'; // mv 30 USD
const DAY_MS = 24 * 60 * 60 * 1000;

// No FxRate row is seeded and cards carry the model-default multiplier, so the
// MYR winnings column is mv × 1.2 (DEFAULT_MARKET_MULTIPLIER) × 4.7
// (DEFAULT_USD_MYR).
const MYR = (usd: number) => Math.round(usd * 1.2 * 4.7 * 100) / 100;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('leaderboard aggregation', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
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

        await packs.createPulls([
          // C3: 3 × packB+cardX → spend 60 → points 6000; winnings 3×50 USD (recent)
          ...pulls('cus_lb_3', PACK_B, CARD_X, now, 3),
          // C1: 2 × packA+cardX → spend 20 → points 2000; winnings 100 USD (recent)
          ...pulls('cus_lb_1', PACK_A, CARD_X, now, 2),
          // C2: 1 × packB+cardY → spend 20 → points 2000; winnings 30 USD (recent)
          ...pulls('cus_lb_2', PACK_B, CARD_Y, now, 1),
          // C4: 5 × packB+cardX OLD → spend 100 (alltime #1, weekly excluded)
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

      it('ranks the weekly window by ledger spend with a deterministic tie-break', async () => {
        const entries = await board(); // default = weekly
        expect(entries).toHaveLength(3); // C4's old spend is excluded

        // C3 (6000) > C1 (2000, 2 pulls) > C2 (2000, 1 pull) — the equal-points
        // pair is broken by pulls DESC.
        expect(entries.map((e) => e.seed)).toEqual([
          seedOf('cus_lb_3'),
          seedOf('cus_lb_1'),
          seedOf('cus_lb_2'),
        ]);
        expect(entries[0]).toMatchObject({
          rank: 1,
          points: 6000,
          volume: MYR(150),
          pulls: 3,
        });
        expect(entries[1]).toMatchObject({
          rank: 2,
          points: 2000,
          volume: MYR(100),
          pulls: 2,
        });
        expect(entries[2]).toMatchObject({
          rank: 3,
          points: 2000,
          volume: MYR(30),
          pulls: 1,
        });
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

      it('repricing a pack after the fact does NOT rewrite the ranking', async () => {
        const container = getContainer();
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        // The old metric joined pulls to the CURRENT pack price — repricing
        // pack A to 1000 would have catapulted C1 to #1. Ledger spend is
        // immutable history, so the board must not move.
        const [packA] = await packs.listPacks({ slug: PACK_A }, { take: 1 });
        await packs.updatePacks([{ id: packA.id, price: 1000 }]);

        const entries = await board();
        expect(entries.map((e) => e.seed)).toEqual([
          seedOf('cus_lb_3'),
          seedOf('cus_lb_1'),
          seedOf('cus_lb_2'),
        ]);
        expect(entries[1]).toMatchObject({ points: 2000 });

        // A reversed open nets out too: the reversal is a POSITIVE mirror row
        // with the same 'pack_open' reason, so C1 drops 2000 → 1000 and falls
        // below C2's intact 2000.
        await packs.createCreditTransactions([
          { customer_id: 'cus_lb_1', amount: 10, reason: 'pack_open' },
        ] as Parameters<typeof packs.createCreditTransactions>[0]);
        const afterReversal = await board();
        expect(afterReversal.map((e) => e.seed)).toEqual([
          seedOf('cus_lb_3'),
          seedOf('cus_lb_2'),
          seedOf('cus_lb_1'),
        ]);
        expect(afterReversal[2]).toMatchObject({ points: 1000 });
      });
    });
  },
});
