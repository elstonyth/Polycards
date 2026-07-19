/**
 * Recorded Pull Value (spec 2026-07-19 Iteration 3 follow-up) — integration:modules
 *
 * Asserted contracts:
 *  - A pull with recorded_value_usd stamped is IMMUNE to card price changes on
 *    all three pulled-value aggregates (leaderboardTop volume, challengeWeekTop,
 *    challengeWeekPool) — a mid-week PriceCharting sync can't rewrite history.
 *  - A pull with recorded_value_usd NULL (pre-backfill row) degrades to live
 *    pricing (market_value × multiplier) via the COALESCE fallback.
 *  - backfillRecordedPullValues stamps null pack pulls from CURRENT card values
 *    (pinning them against later price changes), skips reward pulls, and is
 *    what src/scripts/backfill-recorded-pull-value.ts runs.
 *
 * Test-runner caveat: moduleIntegrationTestRunner builds schema from MODEL
 * definitions, not hand-written migrations — runtime logic only.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import { clearFxDisplayCache, DEFAULT_USD_MYR } from '../pricing';
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

jest.setTimeout(300 * 1000);

// No FX row seeded → resolveFxRate falls back to DEFAULT_USD_MYR. Card rows use
// the model-default market_multiplier (1.2), so a $20 card records 24 USD.
const WEEK = { timezone: 'Asia/Kuala_Lumpur', resetDay: 1, resetHour: 0 };
const myr = (usd: number): number =>
  Math.round(usd * DEFAULT_USD_MYR * 100) / 100;

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
  ],
  testSuite: ({ service }) => {
    beforeEach(() => {
      // The 30s FX display cache is module state that outlives fixtures
      // (--runInBand) — clear it so every test resolves DEFAULT_USD_MYR.
      clearFxDisplayCache();
    });

    // Unique IDs per test — the suite shares one DB across its.
    const mkIds = (tag: string) => ({
      customer: `cus_rpv_${tag}`,
      cardHandle: `card-rpv-${tag}`,
      packSlug: `pack-rpv-${tag}`,
    });

    // Seed: active pack + $20 card (default multiplier 1.2) + the pack_open
    // spend row leaderboardTop's ranking CTE anchors on + one pack Pull.
    // recordedValue mirrors what the open workflows stamp (null = legacy row).
    const seed = async (
      ids: ReturnType<typeof mkIds>,
      recordedValue: number | null,
    ) => {
      await service.createPacks([
        {
          slug: ids.packSlug,
          title: 'RPV Pack',
          image: 'img.png',
          category: 'standard',
          status: 'active',
          price: 10,
          buyback_percent: 50,
        },
      ]);
      const [card] = await service.createCards([
        {
          handle: ids.cardHandle,
          name: 'RPV Card',
          set: 'Base',
          grader: 'PSA',
          grade: '10',
          market_value: 20,
          image: 'card.png',
        },
      ]);
      await service.createCreditTransactions([
        {
          customer_id: ids.customer,
          amount: -10,
          reason: 'pack_open' as const,
          pull_id: null,
        },
      ]);
      const [pull] = await service.createPulls([
        {
          customer_id: ids.customer,
          pack_id: ids.packSlug,
          card_id: ids.cardHandle,
          order_id: null,
          rolled_at: new Date(),
          source: 'pack',
          recorded_value_usd: recordedValue,
        },
      ]);
      return { pull, card };
    };

    const volumeFor = async (customerId: string): Promise<number> => {
      const rows = await service.leaderboardTop({ sinceMs: null, limit: 100 });
      return rows.find((r) => r.customer_id === customerId)?.volume ?? -1;
    };

    const weekTopFor = async (
      customerId: string,
    ): Promise<number | undefined> => {
      const rows = await service.challengeWeekTop({ ...WEEK, limit: 100 });
      return rows.find((r) => r.customer_id === customerId)?.volumeMyr;
    };

    describe('Recorded Pull Value', () => {
      it('a card price change does NOT move an already-recorded pull (board, week top, pool)', async () => {
        const ids = mkIds('pinned');
        const { card } = await seed(ids, 24); // draw-time snapshot: 20 × 1.2

        expect(await volumeFor(ids.customer)).toBe(myr(24));
        expect(await weekTopFor(ids.customer)).toBe(myr(24));
        // The pool is a global aggregate, but the equality below is still
        // order-independent: the price mutation touches ONLY this test's card,
        // and every other test's pulls reference their own cards.
        const { pooledMyr: poolBefore } = await service.challengeWeekPool(WEEK);

        // Mid-week price sync: FMV 20 → 999.
        await service.updateCards([{ id: card.id, market_value: 999 }]);
        clearFxDisplayCache();

        expect(await volumeFor(ids.customer)).toBe(myr(24));
        expect(await weekTopFor(ids.customer)).toBe(myr(24));
        const { pooledMyr: poolAfter } = await service.challengeWeekPool(WEEK);
        expect(poolAfter).toBe(poolBefore);

        // Snapshot outlives the card row: soft-deleting the card drops it from
        // the LEFT JOIN, but the stamped value keeps contributing (an
        // un-stamped pull would fall to NULL — the pre-snapshot behavior).
        await service.softDeleteCards([card.id]);
        expect(await volumeFor(ids.customer)).toBe(myr(24));
        expect(await weekTopFor(ids.customer)).toBe(myr(24));
        expect((await service.challengeWeekPool(WEEK)).pooledMyr).toBe(
          poolBefore,
        );
      });

      it('a null recorded_value_usd (pre-backfill row) degrades to live pricing', async () => {
        const ids = mkIds('legacy');
        const { card } = await seed(ids, null);

        // COALESCE fallback: live 20 × 1.2.
        expect(await volumeFor(ids.customer)).toBe(myr(24));

        await service.updateCards([{ id: card.id, market_value: 40 }]);
        clearFxDisplayCache();

        // Un-backfilled rows follow the sync: 40 × 1.2.
        expect(await volumeFor(ids.customer)).toBe(myr(48));
        expect(await weekTopFor(ids.customer)).toBe(myr(48));
      });

      it('backfill stamps null pack pulls from current values and pins them; reward pulls stay null', async () => {
        const ids = mkIds('backfill');
        const { pull, card } = await seed(ids, null);
        const [rewardPull] = await service.createPulls([
          {
            customer_id: ids.customer,
            pack_id: 'reward-box-bronze',
            card_id: 'prize-rpv-backfill', // sentinel handle, no Card row
            order_id: null,
            rolled_at: new Date(),
            source: 'reward',
          },
        ]);

        const stamped = await service.backfillRecordedPullValues();
        expect(stamped).toBeGreaterThanOrEqual(1);

        const [p] = await service.listPulls({ id: pull.id }, { take: 1 });
        expect(Number(p!.recorded_value_usd)).toBe(24); // 20 × 1.2 at backfill time
        const [rp] = await service.listPulls({ id: rewardPull.id }, { take: 1 });
        expect(rp!.recorded_value_usd).toBeNull();

        // Now pinned: a later sync can't move it.
        await service.updateCards([{ id: card.id, market_value: 500 }]);
        clearFxDisplayCache();
        expect(await volumeFor(ids.customer)).toBe(myr(24));

        // Re-run is a no-op for already-stamped rows.
        await service.updateCards([{ id: card.id, market_value: 20 }]);
        const again = await service.backfillRecordedPullValues();
        expect(again).toBe(0);
        expect(Number((await service.listPulls({ id: pull.id }, { take: 1 }))[0]!.recorded_value_usd)).toBe(24);
      });
    });
  },
});
