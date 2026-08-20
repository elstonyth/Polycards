/**
 * Weekly-challenge settlement (spec 2026-07-29) — integration:modules
 *
 * Asserted contracts:
 *  - Windowed aggregates: `weeksBack: 1` pools ONLY the settled (prior) week —
 *    current-week pulls and reward pulls are excluded.
 *  - settleChallengeWeek happy path: credits paid through the ledger, card
 *    minted as a source='reward' Pull carrying the card HANDLE, payout rows
 *    written once; a second run is a settled-week no-op (idempotent).
 *  - Stock NEVER gates a grant (2026-08-17): an empty counter still mints the
 *    pull. `skipped_no_stock` survives only for a prize whose Card row is gone.
 *  - grantSkippedChallengeCards: rows written under the old stock gate are
 *    granted retroactively, once.
 *
 * Test-runner caveat: moduleIntegrationTestRunner builds schema from MODEL
 * definitions (this file's moduleModels array), not hand-written migrations —
 * runtime logic only; the partial-unique backstop index lives in the migration.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import { clearFxDisplayCache } from '../pricing';
import Pack from '../models/pack';
import Card from '../models/card';
import PackOdds from '../models/pack-odds';
import Pull from '../models/pull';
import CreditTransaction from '../models/credit-transaction';
import DeliveryOrder from '../models/delivery-order';
import DeliveryOrderItem from '../models/delivery-order-item';
import VipLevel from '../models/vip-level';
import RewardsSettings from '../models/rewards-settings';
import ReferralRelationship from '../models/referral-relationship';
import Commission from '../models/commission';
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';
import VipMemberState from '../models/vip-member-state';
import VipRewardGrant from '../models/vip-reward-grant';
import NotificationRead from '../models/notification-read';
import RewardDraw from '../models/reward-draw';
import FxRate from '../models/fx-rate';
import PixelPokemon from '../models/pixel-pokemon';
import ChallengeStage from '../models/challenge-stage';
import ChallengeSettings from '../models/challenge-settings';
import ChallengePayout from '../models/challenge-payout';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';

jest.setTimeout(300 * 1000);

const WEEK = { timezone: 'UTC', resetDay: 1, resetHour: 0 }; // Monday 00:00 UTC

// Deterministic week boundary: the CURRENT week's start (most recent Monday
// 00:00 UTC, today included). Pulls at monday − 12h land in the PRIOR week
// (weeksBack: 1's window) and monday + 12h in the current week, on ANY
// weekday — no daysAgo() guesswork near the reset instant.
function currentWeekStartUtc(): Date {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - 1 + 7) % 7)); // 0=Sun..6=Sat
  return d;
}
const HOUR = 60 * 60 * 1000;
const priorWeekDate = () =>
  new Date(currentWeekStartUtc().getTime() - 12 * HOUR);
const currentWeekDate = () =>
  new Date(currentWeekStartUtc().getTime() + 12 * HOUR);
// The settled week's OWN start (weeksBack: 1 shifts the whole week left 7
// days — see CHALLENGE_WEEK_ANCHOR_CTE) — what settleChallengeWinner's WP
// ref_id (`challenge:<weekStartIso>:<customerId>`) is keyed on.
const priorWeekStartUtc = () =>
  new Date(currentWeekStartUtc().getTime() - 7 * 24 * HOUR);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    Pack,
    Card,
    PackOdds,
    Pull,
    CreditTransaction,
    DeliveryOrder,
    DeliveryOrderItem,
    VipLevel,
    RewardsSettings,
    ReferralRelationship,
    Commission,
    CustomerAccountState,
    AdminActionAudit,
    VipMemberState,
    VipRewardGrant,
    NotificationRead,
    RewardDraw,
    FxRate,
    PixelPokemon,
    ChallengeStage,
    ChallengeSettings,
    ChallengePayout,
    LedgerEntry,
    LedgerSequence,
  ],
  testSuite: ({ service }) => {
    beforeEach(() => {
      // The 30s FX display cache is module state that outlives fixtures
      // (--runInBand) — clear it so every test resolves the seeded rate.
      clearFxDisplayCache();
    });

    // FX 4.0 + UTC-Monday settings + one $100 card. Prior-week pull worth
    // USD 100 × fx 4 = MYR 400 in the pool.
    async function seedBase() {
      await service.createFxRates([
        { pair: 'USD_MYR', rate: 4, source: 'test', manual_override: false },
      ]);
      await service.createChallengeSettings([
        {
          id: 'global',
          cadence: 'fixed_weekly',
          timezone: WEEK.timezone,
          reset_day: WEEK.resetDay,
          reset_hour: WEEK.resetHour,
          payout_credits: 0,
          // model.json() generates Record<string, unknown> create types — a
          // plain array needs the same double-cast the service uses.
          payout_card_ids: [] as unknown as Record<string, unknown>,
        },
      ]);
      const [card] = await service.createCards([
        {
          handle: 'test-charizard',
          name: 'Test Charizard',
          set: 'Base',
          grader: 'PSA',
          grade: '10',
          market_value: 100,
          image: 'x.webp',
        },
      ]);
      return { card: card! };
    }

    async function seedPriorWeekPull(
      customerId: string,
      card: { handle: string },
      valueUsd = 100,
    ) {
      await service.createPulls([
        {
          customer_id: customerId,
          pack_id: 'bronze-pack',
          card_id: card.handle,
          order_id: null,
          rolled_at: priorWeekDate(),
          source: 'pack',
          recorded_value_usd: valueUsd,
        },
      ]);
    }

    /** One stage whose rank table is the argument. */
    async function seedStage(
      stageNumber: number,
      thresholdMyr: number,
      rankRewards: { rank: number; card_id?: string; credits: number }[],
    ) {
      await service.createChallengeStages([
        {
          stage_number: stageNumber,
          threshold_myr: thresholdMyr,
          // model.json() generates Record<string, unknown> create types.
          rank_rewards: rankRewards as unknown as Record<string, unknown>,
        },
      ]);
    }

    describe('windowed challenge-week aggregates', () => {
      it('pools only the settled week — current-week and reward pulls excluded', async () => {
        const { card } = await seedBase();
        await seedPriorWeekPull('cus_a', card); // prior week → counts
        await service.createPulls([
          {
            customer_id: 'cus_a',
            pack_id: 'bronze-pack',
            card_id: card.handle,
            order_id: null,
            rolled_at: currentWeekDate(),
            source: 'pack',
            recorded_value_usd: 100,
          }, // current week → excluded
          {
            customer_id: 'cus_a',
            pack_id: 'challenge-x',
            card_id: card.handle,
            order_id: null,
            rolled_at: priorWeekDate(),
            source: 'reward',
            recorded_value_usd: 100,
          }, // reward → excluded
        ]);
        const pool = await service.challengeWeekPool({ ...WEEK, weeksBack: 1 });
        expect(pool).toBe(400); // one pull × USD100 × fx4
      });
    });

    describe('settleChallengeWeek', () => {
      it('settles once: credits paid, card minted, second run is a no-op', async () => {
        const { card } = await seedBase();
        await service.createChallengeStages([
          {
            stage_number: 1,
            threshold_myr: 100,
            rank_rewards: [
              { rank: 1, card_id: card.id, credits: 50 },
            ] as unknown as Record<string, unknown>,
          },
        ]);
        await seedPriorWeekPull('cus_a', card);

        const first = await service.settleChallengeWeek({});
        expect(first.settled).toBe(true);
        expect(first.winners).toEqual([
          expect.objectContaining({
            customerId: 'cus_a',
            rank: 1,
            credits: 50,
            cardHandles: [card.handle],
            skippedCardIds: [],
          }),
        ]);
        expect(await service.creditBalance('cus_a')).toBe(50);
        const rewardPulls = await service.listPulls(
          { customer_id: 'cus_a', source: 'reward' },
          { take: 10 },
        );
        expect(rewardPulls).toHaveLength(1);
        expect(rewardPulls[0]!.card_id).toBe(card.handle); // HANDLE, not id

        const second = await service.settleChallengeWeek({});
        expect(second.settled).toBe(false);
        expect(await service.creditBalance('cus_a')).toBe(50); // unchanged
        const payoutRows = await service.listChallengePayouts({}, { take: 10 });
        expect(payoutRows).toHaveLength(2); // credits row + card row, once
      });

      // Plan 060: settleChallengeWinner now writes the WP transaction-ledger
      // row the admin Transactions filter has offered since POLYCARD-BACK §5
      // with no writer behind it.
      describe('WP ledger row', () => {
        it('writes exactly one WP row with the credited amount and the challenge ref_id', async () => {
          const { card } = await seedBase();
          await seedStage(1, 100, [{ rank: 1, card_id: card.id, credits: 50 }]);
          await seedPriorWeekPull('cus_a', card);

          await service.settleChallengeWeek({});

          const wpRows = await service.listLedgerEntries(
            { type: 'WP', customer_id: 'cus_a' },
            { take: 10 },
          );
          expect(wpRows).toHaveLength(1);
          expect(wpRows[0]!.ref_id).toBe(
            `challenge:${priorWeekStartUtc().toISOString()}:cus_a`,
          );
          expect(Number(wpRows[0]!.wallet_delta)).toBe(50);
        });

        it('re-running settlement for the same week does not write a second WP row', async () => {
          const { card } = await seedBase();
          await seedStage(1, 100, [{ rank: 1, card_id: card.id, credits: 50 }]);
          await seedPriorWeekPull('cus_a', card);
          await service.settleChallengeWeek({});
          // Clear the payout-row gate (settleChallengeWinner's step 2 check
          // AND the 2b anchor-overlap guard both query challenge_payout) so
          // the second pass genuinely re-enters 3a/3b/3c instead of short-
          // circuiting before reaching recordLedgerEntry — otherwise this
          // would only re-prove the payout-row no-op the earlier "settles
          // once" test already covers, not recordLedgerEntry's OWN
          // (type, ref_id) idempotency.
          await service.deleteChallengePayouts(
            (await service.listChallengePayouts({}, { take: 20 })).map(
              (r) => r.id,
            ),
          );
          await service.settleChallengeWeek({});

          const wpRows = await service.listLedgerEntries(
            { type: 'WP', customer_id: 'cus_a' },
            { take: 10 },
          );
          expect(wpRows).toHaveLength(1); // recordLedgerEntry found the existing row
        });

        it('a card-only rank (credits = 0) still writes its WP row', async () => {
          const { card } = await seedBase();
          await seedStage(1, 100, [{ rank: 1, card_id: card.id, credits: 0 }]);
          await seedPriorWeekPull('cus_a', card);

          await service.settleChallengeWeek({});

          const wpRows = await service.listLedgerEntries(
            { type: 'WP', customer_id: 'cus_a' },
            { take: 10 },
          );
          expect(wpRows).toHaveLength(1);
          expect(Number(wpRows[0]!.wallet_delta)).toBe(0);
          const payload = wpRows[0]!.payload as unknown as {
            sku: string | null;
          };
          expect(payload.sku).toBe(card.handle);
        });
      });

      it('mints qty pulls in one call and records every id when two stages award the same card', async () => {
        const { card } = await seedBase();
        // Pool = MYR 400, so BOTH stages unlock and rank 1 collects the same
        // card twice (spec rule 5: union of every unlocked stage's table,
        // credits summed).
        await service.createChallengeStages([
          {
            stage_number: 1,
            threshold_myr: 100,
            rank_rewards: [
              { rank: 1, card_id: card.id, credits: 50 },
            ] as unknown as Record<string, unknown>,
          },
          {
            stage_number: 2,
            threshold_myr: 200,
            rank_rewards: [
              { rank: 1, card_id: card.id, credits: 25 },
            ] as unknown as Record<string, unknown>,
          },
        ]);
        await seedPriorWeekPull('cus_a', card);

        const result = await service.settleChallengeWeek({});
        expect(result.winners[0]!.skippedCardIds).toEqual([]);
        expect(result.winners[0]!.cardCount).toBe(2); // MINTED, not distinct
        expect(result.winners[0]!.cardHandles).toEqual([card.handle]); // distinct
        expect(await service.creditBalance('cus_a')).toBe(75); // 50 + 25

        const rewardPulls = await service.listPulls(
          { customer_id: 'cus_a', source: 'reward' },
          { take: 10 },
        );
        expect(rewardPulls).toHaveLength(2);

        // ONE card payout row (both copies dedupe into one qty entry) carrying
        // BOTH minted pull ids; the scalar column keeps the first.
        const cardRows = await service.listChallengePayouts(
          { kind: 'card' },
          { take: 5 },
        );
        expect(cardRows).toHaveLength(1);
        const snapshot = cardRows[0]!.snapshot as unknown as {
          qty: number;
          pull_ids: string[];
        };
        expect(snapshot.qty).toBe(2);
        // Set-equality: listPulls has no guaranteed ordering and the copies are
        // identical, so order carries no meaning.
        expect([...snapshot.pull_ids].sort()).toEqual(
          rewardPulls.map((p) => p.id).sort(),
        );
        expect(cardRows[0]!.pull_id).toBe(snapshot.pull_ids[0]);
      });

      // The inverse of the old gate test. Stock is a fulfilment COUNTER (see
      // card-stock.ts), so an empty one grants anyway and the counter is left
      // to go negative — that negative is the operator's "units owed" signal.
      // The take is the only thing stock touches here.
      it('grants and mints even when the card has no stock left', async () => {
        const { card } = await seedBase();
        await service.createChallengeStages([
          {
            stage_number: 1,
            threshold_myr: 100,
            rank_rewards: [
              { rank: 1, card_id: card.id, credits: 0 },
            ] as unknown as Record<string, unknown>,
          },
        ]);
        await seedPriorWeekPull('cus_a', card);

        const takes: Array<[string, number]> = [];
        const result = await service.settleChallengeWeek({
          decrementStock: async (handle, qty) => {
            takes.push([handle, qty]); // stock at 0 — taken anyway, goes negative
            return true;
          },
        });
        expect(result.winners[0]!.skippedCardIds).toEqual([]);
        expect(result.winners[0]!.cardCount).toBe(1);
        expect(takes).toEqual([[card.handle, 1]]);

        const rows = await service.listChallengePayouts(
          { kind: 'card' },
          { take: 5 },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe('granted');
        const pulls = await service.listPulls(
          { customer_id: 'cus_a', source: 'reward' },
          { take: 5 },
        );
        expect(pulls).toHaveLength(1);
        expect(rows[0]!.pull_id).toBe(pulls[0]!.id);
      });

      // The ONLY skip left: the prize's Card row is gone, so there is no handle
      // to key a pull on. The week still gates (a payout row was written).
      it('records skipped_no_stock when the prize card no longer exists', async () => {
        const { card } = await seedBase();
        await seedStage(1, 100, [
          { rank: 1, card_id: 'card_deleted', credits: 0 },
        ]);
        await seedPriorWeekPull('cus_a', card);

        const result = await service.settleChallengeWeek({});
        expect(result.winners[0]!.skippedCardIds).toEqual(['card_deleted']);
        const rows = await service.listChallengePayouts(
          { kind: 'card' },
          { take: 5 },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe('skipped_no_stock');
        expect(rows[0]!.pull_id).toBeNull();
        expect(
          (rows[0]!.snapshot as unknown as { pull_ids: string[] }).pull_ids,
        ).toEqual([]); // always present, empty when nothing minted
        expect(
          await service.listPulls(
            { customer_id: 'cus_a', source: 'reward' },
            { take: 5 },
          ),
        ).toHaveLength(0);
        // A skipped week still gates: settled-week record exists.
        expect((await service.settleChallengeWeek({})).settled).toBe(false);
      });

      // The retro-grant for rows the OLD stock gate wrote. settleChallengeWeek
      // can never reach them again (its re-entry gate is per customer), so this
      // is the only path that hands those prizes over.
      describe('grantSkippedChallengeCards', () => {
        it('mints the pull, flips the row granted, and is a no-op on re-run', async () => {
          const { card } = await seedBase();
          const weekStart = priorWeekStartUtc();
          await service.createChallengePayouts([
            {
              week_start: weekStart,
              customer_id: 'cus_a',
              rank: 1,
              kind: 'card' as const,
              card_id: card.id,
              credits: 0,
              credit_transaction_id: null,
              pull_id: null,
              status: 'skipped_no_stock' as const,
              snapshot: { qty: 2, pull_ids: [] },
            },
          ]);

          const takes: Array<[string, number]> = [];
          const first = await service.grantSkippedChallengeCards({
            decrementStock: async (handle, qty) => {
              takes.push([handle, qty]);
              return true;
            },
          });
          expect(first).toEqual({ granted: 1, pulls: 2, stillSkipped: [] });
          expect(takes).toEqual([[card.handle, 2]]);

          const pulls = await service.listPulls(
            { customer_id: 'cus_a', source: 'reward' },
            { take: 5 },
          );
          expect(pulls).toHaveLength(2); // snapshot.qty copies
          expect(pulls[0]!.card_id).toBe(card.handle); // HANDLE, not id
          expect(pulls.every((p) => p.stock_earmarked)).toBe(true);

          const [row] = await service.listChallengePayouts(
            { kind: 'card' },
            { take: 5 },
          );
          expect(row!.status).toBe('granted');
          expect(row!.pull_id).toBe(
            (row!.snapshot as unknown as { pull_ids: string[] }).pull_ids[0],
          );

          // Idempotent: the selector no longer matches a granted row.
          expect(await service.grantSkippedChallengeCards({})).toEqual({
            granted: 0,
            pulls: 0,
            stillSkipped: [],
          });
          expect(
            await service.listPulls(
              { customer_id: 'cus_a', source: 'reward' },
              { take: 5 },
            ),
          ).toHaveLength(2);
        });

        it('leaves a row skipped when its prize card is gone', async () => {
          await seedBase();
          await service.createChallengePayouts([
            {
              week_start: priorWeekStartUtc(),
              customer_id: 'cus_a',
              rank: 1,
              kind: 'card' as const,
              card_id: 'card_deleted',
              credits: 0,
              credit_transaction_id: null,
              pull_id: null,
              status: 'skipped_no_stock' as const,
              snapshot: { qty: 1, pull_ids: [] },
            },
          ]);

          const result = await service.grantSkippedChallengeCards({});
          expect(result.granted).toBe(0);
          expect(result.stillSkipped).toHaveLength(1);
          expect(
            await service.listPulls(
              { customer_id: 'cus_a', source: 'reward' },
              { take: 5 },
            ),
          ).toHaveLength(0);
        });
      });

      it('takes the unit after the payout commits and flags the minted pull', async () => {
        const { card } = await seedBase();
        await service.createChallengeStages([
          {
            stage_number: 1,
            threshold_myr: 100,
            rank_rewards: [
              { rank: 1, card_id: card.id, credits: 0 },
            ] as unknown as Record<string, unknown>,
          },
        ]);
        await seedPriorWeekPull('cus_a', card);

        const takes: Array<[string, number]> = [];
        await service.settleChallengeWeek({
          decrementStock: async (handle, qty) => {
            takes.push([handle, qty]);
            // The contract the fix exists for, asserted from INSIDE the
            // callback: by the time the take runs, the payout transaction has
            // already committed. Checked after the fact, both orderings look
            // identical - which is why the first version of this test passed
            // against the buggy code too.
            const committed = await service.listChallengePayouts(
              { kind: 'card' },
              { take: 5 },
            );
            expect(committed).toHaveLength(1);
            expect(committed[0]!.status).toBe('granted');
            const minted = await service.listPulls(
              { customer_id: 'cus_a', source: 'reward' },
              { take: 5 },
            );
            expect(minted).toHaveLength(1);
            expect(minted[0]!.stock_earmarked).toBe(false);
            return true;
          },
        });

        expect(takes).toEqual([[card.handle, 1]]);
        const pulls = await service.listPulls(
          { customer_id: 'cus_a', source: 'reward' },
          { take: 5 },
        );
        expect(pulls).toHaveLength(1);
        // Minted unflagged, flipped only once the take confirmed.
        expect(pulls[0]!.stock_earmarked).toBe(true);
      });

      it('a failed take leaves the payout paid, the pull unflagged, and never retakes', async () => {
        // Regression for two defects that shipped together. The take used to run
        // INSIDE settleChallengeWinner's transaction, but adjustInventory commits
        // on the inventory module's own connection and cannot roll back with us.
        // A throw then took two victims:
        //
        //   1. the catch did `skippedCardIds.push(cardId); continue;`, and that
        //      continue skipped the rows.push below — the prize vanished with no
        //      payout row at all, not even skipped_no_stock;
        //   2. no payout row meant the winner was absent from settledCustomers,
        //      so the next hourly tick re-settled them and took the unit AGAIN,
        //      every hour for the ~168 ticks weeksBack:1 keeps the week in scope.
        //
        // Both assertions below fail on that code: rows came back empty, and
        // calls reached 2.
        const { card } = await seedBase();
        await service.createChallengeStages([
          {
            stage_number: 1,
            threshold_myr: 100,
            rank_rewards: [
              { rank: 1, card_id: card.id, credits: 0 },
            ] as unknown as Record<string, unknown>,
          },
        ]);
        await seedPriorWeekPull('cus_a', card);

        let calls = 0;
        const deps = {
          decrementStock: async () => {
            calls += 1;
            throw new Error('inventory unavailable');
          },
        };

        const first = await service.settleChallengeWeek(deps);
        expect(first.settled).toBe(true); // a counter must never undo a payout
        expect(calls).toBe(1);

        const rows = await service.listChallengePayouts(
          { kind: 'card' },
          { take: 5 },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe('granted');

        const pulls = await service.listPulls(
          { customer_id: 'cus_a', source: 'reward' },
          { take: 5 },
        );
        expect(pulls).toHaveLength(1);
        // Unflagged: buyback restores flagged pulls only, so a unit that was
        // never taken must never be handed back.
        expect(pulls[0]!.stock_earmarked).toBe(false);

        // The drain guard: a second tick must not take again.
        const second = await service.settleChallengeWeek(deps);
        expect(second.settled).toBe(false);
        expect(calls).toBe(1);
      });

      it('maps rank from ranking position: three winners each get THEIR prize', async () => {
        const { card } = await seedBase();
        await seedStage(1, 100, [
          { rank: 1, card_id: card.id, credits: 100 },
          { rank: 2, credits: 50 },
          { rank: 3, credits: 25 },
        ]);
        // Clearly separated volumes — equal volumes leave challengeWeekTop's
        // ordering undefined and the rank assertions flaky in CI.
        await seedPriorWeekPull('cus_a', card, 300);
        await seedPriorWeekPull('cus_b', card, 200);
        await seedPriorWeekPull('cus_c', card, 100);

        const r = await service.settleChallengeWeek({});
        expect(
          r.winners.map((w) => [w.customerId, w.rank, w.credits, w.cardCount]),
        ).toEqual([
          ['cus_a', 1, 100, 1],
          ['cus_b', 2, 50, 0],
          ['cus_c', 3, 25, 0],
        ]);
        expect(await service.creditBalance('cus_a')).toBe(100);
        expect(await service.creditBalance('cus_b')).toBe(50);
        expect(await service.creditBalance('cus_c')).toBe(25);
      });

      it('an admin anchor change cannot re-pay a week overlapping a paid one', async () => {
        const { card } = await seedBase();
        await seedStage(1, 100, [{ rank: 1, credits: 50 }]);
        // Spread over ~2 weeks: reset_day is admin-editable in BOTH directions
        // and the resulting shift depends on today's weekday, so a single pull
        // could leave the shifted window empty — which would make this test
        // pass for the wrong reason (empty window, guard never reached).
        const weekStart = currentWeekStartUtc().getTime();
        for (const days of [0.5, 3, 6, 9, 12]) {
          await service.createPulls([
            {
              customer_id: 'cus_a',
              pack_id: 'bronze-pack',
              card_id: card.handle,
              order_id: null,
              rolled_at: new Date(weekStart - days * 24 * HOUR),
              source: 'pack',
              recorded_value_usd: 100,
            },
          ]);
        }

        const first = await service.settleChallengeWeek({});
        expect(first.settled).toBe(true);
        expect(await service.creditBalance('cus_a')).toBe(50);
        const rowsBefore = await service.listChallengePayouts({}, { take: 20 });

        // Admin moves the weekly reset Monday -> Tuesday. week_start is the key
        // behind EVERY idempotency layer (payout rows, the unique index, the
        // ledger idempotencyReference), so the next tick resolves a different
        // one: without the interval-overlap guard it finds nothing and re-pays.
        await service.updateChallengeSettings({ id: 'global', reset_day: 2 });
        const shifted = { ...WEEK, resetDay: 2, weeksBack: 1 };
        // Discriminators: cus_a is STILL ranked under the new anchor and the
        // stage still unlocks, so settled:false below can ONLY be the guard.
        expect(
          (await service.challengeWeekTop({ ...shifted, limit: 10 })).map(
            (t) => t.customer_id,
          ),
        ).toContain('cus_a');
        expect(await service.challengeWeekPool(shifted)).toBeGreaterThanOrEqual(
          100,
        );

        const second = await service.settleChallengeWeek({});
        expect(second.settled).toBe(false);
        expect(await service.creditBalance('cus_a')).toBe(50); // NOT re-paid
        expect(
          await service.listChallengePayouts({}, { take: 20 }),
        ).toHaveLength(rowsBefore.length);
      });

      it('replays the frozen snapshot after a mid-batch crash — a reversal cannot re-rank a closed week', async () => {
        const { card } = await seedBase();
        await seedStage(1, 100, [
          { rank: 1, card_id: card.id, credits: 100 },
          { rank: 2, card_id: card.id, credits: 50 },
        ]);
        await seedPriorWeekPull('cus_a', card, 300);
        await seedPriorWeekPull('cus_b', card, 200);
        await seedPriorWeekPull('cus_c', card, 100);

        // The state tick 1 leaves behind when it commits rank 1 and dies inside
        // rank 2's transaction: rank 1's payout rows exist and carry the FROZEN
        // snapshot; rank 2 has nothing. Seeded rather than crashed into — every
        // in-transaction seam (createPulls, mutateCreditAtomic) lives on the
        // module-service Proxy and cannot be patched from out here.
        //
        // Narrower than the crash it replaces, deliberately: the resume path
        // reads ONLY customer_id + snapshot off these rows (see
        // settleChallengeWeek's existingRows select), so rank 1's committed
        // credits and WP row are not part of what tick 2 decides on — and are
        // no longer exercised here.
        await service.createChallengePayouts([
          {
            week_start: priorWeekStartUtc(),
            customer_id: 'cus_a',
            rank: 1,
            kind: 'credits' as const,
            card_id: '',
            credits: 100,
            credit_transaction_id: null,
            pull_id: null,
            status: 'granted' as const,
            snapshot: {
              pool_myr: 2400,
              unlocked_stages: [1],
              week_end: currentWeekStartUtc().toISOString(),
              ranking: ['cus_a', 'cus_b', 'cus_c'],
              by_rank: {
                '1': { rank: 1, credits: 100, cardIds: [card.id] },
                '2': { rank: 2, credits: 50, cardIds: [card.id] },
              },
            },
          },
        ]);
        expect(await service.creditBalance('cus_b')).toBe(0);

        // An admin reversal soft-deletes the rank-1 pull. Both aggregates
        // filter deleted_at IS NULL, so the LIVE ranking is now
        // [cus_b, cus_c] — a recomputing tick would hand cus_b the rank-1
        // prize and promote cus_c into the rank-2 prize, paying a second
        // prize table for one week with nobody paid twice.
        const [aPull] = await service.listPulls(
          { customer_id: 'cus_a', source: 'pack' },
          { take: 1 },
        );
        await service.softDeletePulls([aPull!.id]);

        const second = await service.settleChallengeWeek({});
        expect(
          second.winners.map((w) => [w.customerId, w.rank, w.credits]),
        ).toEqual([['cus_b', 2, 50]]); // FROZEN rank 2, not the re-ranked 1
        expect(await service.creditBalance('cus_b')).toBe(50);
        expect(await service.creditBalance('cus_c')).toBe(0); // never promoted
      });

      // b6bcf484 moved frozenByRank AHEAD of the empty-`unlocked` early return.
      // That fix shipped without a test; this is it (#431). `unlocked` is
      // rebuilt by filtering LIVE stages against the frozen unlocked_stages, so
      // an admin deleting the stage between ticks empties it — and the gate,
      // reached first, used to strand every unpaid winner behind a prize table
      // we had already frozen and still held.
      it('pays the rest of a partial settlement after an admin deletes the unlocked stage', async () => {
        const { card } = await seedBase();
        await seedStage(1, 100, [
          { rank: 1, credits: 100 },
          { rank: 2, credits: 50 },
        ]);
        await seedPriorWeekPull('cus_a', card, 300);
        await seedPriorWeekPull('cus_b', card, 200);

        // Tick 1: rank 1 committed, rank 2 not yet — seeded rather than
        // crashed into, for the reason the sibling test above gives.
        //
        // The frozen rank-2 credits are 777, a number NO live stage can
        // produce here. A regression that falls back to payoutByRank(unlocked)
        // then fails loudly instead of coincidentally matching the seeded 50.
        await service.createChallengePayouts([
          {
            week_start: priorWeekStartUtc(), // EXACT startUtc — the gate's lookup is exact-match
            customer_id: 'cus_a',
            rank: 1,
            kind: 'credits' as const,
            card_id: '',
            credits: 100,
            credit_transaction_id: null,
            pull_id: null,
            status: 'granted' as const,
            snapshot: {
              pool_myr: 2000,
              unlocked_stages: [1],
              week_end: currentWeekStartUtc().toISOString(),
              ranking: ['cus_a', 'cus_b'],
              by_rank: {
                '1': { rank: 1, credits: 100, cardIds: [] },
                '2': { rank: 2, credits: 777, cardIds: [] },
              },
            },
          },
        ]);

        // The admin edit that used to strand cus_b: the only unlocked stage is
        // deleted between ticks, so nothing live backs the frozen table.
        await service.deleteChallengeStages(
          (await service.listChallengeStages({}, { take: 10 })).map((r) => r.id),
        );

        const tick2 = await service.settleChallengeWeek({});
        expect(
          tick2.winners.map((w) => [w.customerId, w.rank, w.credits]),
        ).toEqual([['cus_b', 2, 777]]);
        expect(await service.creditBalance('cus_b')).toBe(777);

        // The frozen record survives the tick that consumed it — a THIRD tick
        // must still see the stage list tick 1 froze, not one shrunk by the
        // deletion.
        const [bRow] = await service.listChallengePayouts(
          { customer_id: 'cus_b' },
          { take: 1 },
        );
        expect(
          (bRow!.snapshot as unknown as { unlocked_stages: number[] })
            .unlocked_stages,
        ).toEqual([1]);
      });

      it('early-returns with no participants and with no unlocked stage', async () => {
        const { card } = await seedBase();
        // Threshold 0 unlocks on an empty pool, so this reaches the ranking
        // step with nobody ranked.
        await seedStage(1, 0, [{ rank: 1, credits: 50 }]);
        const empty = await service.settleChallengeWeek({});
        expect(empty).toEqual({
          weekStartIso: expect.any(String),
          settled: false,
          winners: [],
        });

        // Now there IS a participant (pool 400) but no stage it can unlock.
        await service.createChallengeStages([
          {
            stage_number: 2,
            threshold_myr: 10_000,
            rank_rewards: [{ rank: 1, credits: 50 }] as unknown as Record<
              string,
              unknown
            >,
          },
        ]);
        await service.deleteChallengeStages(
          (
            await service.listChallengeStages({ stage_number: 1 }, { take: 1 })
          ).map((r) => r.id),
        );
        await seedPriorWeekPull('cus_a', card);
        const locked = await service.settleChallengeWeek({});
        expect(locked.settled).toBe(false);
        expect(await service.creditBalance('cus_a')).toBe(0);
        expect(
          await service.listChallengePayouts({}, { take: 5 }),
        ).toHaveLength(0);
      });
    });
  },
});
