/**
 * Weekly-challenge settlement (spec 2026-07-29) — integration:modules
 *
 * Asserted contracts:
 *  - Windowed aggregates: `weeksBack: 1` pools ONLY the settled (prior) week —
 *    current-week pulls and reward pulls are excluded.
 *  - settleChallengeWeek happy path: credits paid through the ledger, card
 *    minted as a source='reward' Pull carrying the card HANDLE, payout rows
 *    written once; a second run is a settled-week no-op (idempotent).
 *  - skipped_no_stock: tracked-but-empty stock records the payout row with no
 *    pull and no credit substitution, and still gates the week.
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
    ) {
      await service.createPulls([
        {
          customer_id: customerId,
          pack_id: 'bronze-pack',
          card_id: card.handle,
          order_id: null,
          rolled_at: priorWeekDate(),
          source: 'pack',
          recorded_value_usd: 100,
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

        const stock = new Map<string, number | null>([[card.handle, null]]); // untracked = grantable
        const deps = { getStock: async () => stock };

        const first = await service.settleChallengeWeek(deps);
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

        const second = await service.settleChallengeWeek(deps);
        expect(second.settled).toBe(false);
        expect(await service.creditBalance('cus_a')).toBe(50); // unchanged
        const payoutRows = await service.listChallengePayouts({}, { take: 10 });
        expect(payoutRows).toHaveLength(2); // credits row + card row, once
      });

      it('records skipped_no_stock and mints no pull when stock is short', async () => {
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

        const result = await service.settleChallengeWeek({
          getStock: async () =>
            new Map<string, number | null>([[card.handle, 0]]), // tracked, none left
        });
        expect(result.winners[0]!.skippedCardIds).toEqual([card.id]);
        const rows = await service.listChallengePayouts(
          { kind: 'card' },
          { take: 5 },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe('skipped_no_stock');
        expect(rows[0]!.pull_id).toBeNull();
        expect(
          await service.listPulls(
            { customer_id: 'cus_a', source: 'reward' },
            { take: 5 },
          ),
        ).toHaveLength(0);
        // A skipped week still gates: settled-week record exists.
        expect(
          (
            await service.settleChallengeWeek({
              getStock: async () =>
                new Map<string, number | null>([[card.handle, 0]]),
            })
          ).settled,
        ).toBe(false);
      });
    });
  },
});
