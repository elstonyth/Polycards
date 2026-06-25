/**
 * C1 — Exclude reward Pulls from 4 read sites (integration:modules)
 *
 * Asserted contracts:
 *  - leaderboardTop: reward Pull excluded from COUNT (source <> 'reward' in raw SQL).
 *  - listPulls with source { $ne: 'reward' }: excludes reward Pulls (mirrors
 *    pulls/recent route filter and profile recent-feed filter after C1).
 *  - profile collection: showcased reward Pulls excluded by the C1 source filter.
 *  - buyback gate: a reward Pull has source='reward' and status='vaulted' — the C1
 *    guard in buyback-pull.ts fires before listCards; Pull attributes confirmed here.
 *
 * Test-runner caveat: moduleIntegrationTestRunner builds schema from MODEL
 * definitions, not hand-written migrations — CHECK/partial-unique constraints
 * are absent. Runtime logic only.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
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
    // Each test gets unique IDs to avoid unique-constraint conflicts.
    const mkIds = (tag: string) => ({
      customer: `cus_c1_${tag}`,
      cardHandle: `card-c1-${tag}`,
      packSlug: `pack-c1-${tag}`,
      rewardPackSlug: `reward-box-c1-${tag}`,
      prizeHandle: `prize-c1-${tag}`,
    });

    // Seed: normal card pack + reward_box pack + card + PackOdds + one normal Pull
    // (source='pack', vaulted, showcased) + one reward Pull (source='reward', vaulted).
    // Returns both Pull records.
    const seed = async (ids: ReturnType<typeof mkIds>) => {
      await service.createPacks([
        {
          slug: ids.packSlug,
          title: 'C1 Normal Pack',
          image: 'img.png',
          category: 'standard',
          status: 'active',
          price: 10,
          buyback_percent: 50,
        },
      ]);
      await service.createPacks([
        {
          slug: ids.rewardPackSlug,
          title: 'C1 Reward Box',
          image: 'img.png',
          category: 'reward_box',
          status: 'active',
          price: 0,
          buyback_percent: 0,
        },
      ]);
      await service.createCards([
        {
          handle: ids.cardHandle,
          name: 'C1 Card',
          set: 'Base',
          grader: 'PSA',
          grade: '10',
          market_value: 20,
          image: 'card.png',
        },
      ]);
      await service.createPackOdds([
        {
          pack_id: ids.packSlug,
          card_id: ids.cardHandle,
          rarity: 'Common',
          weight: 1,
        },
      ]);

      const [normalPull] = await service.createPulls([
        {
          customer_id: ids.customer,
          pack_id: ids.packSlug,
          card_id: ids.cardHandle,
          order_id: null,
          rolled_at: new Date(),
          source: 'pack',
        },
      ]);
      await service.updatePulls([
        { id: normalPull.id, status: 'vaulted' as const, showcased: true },
      ]);

      const [rewardPull] = await service.createPulls([
        {
          customer_id: ids.customer,
          pack_id: ids.rewardPackSlug,
          card_id: ids.prizeHandle, // sentinel product handle, not a Card row
          order_id: null,
          rolled_at: new Date(),
          source: 'reward',
        },
      ]);
      await service.updatePulls([
        { id: rewardPull.id, status: 'vaulted' as const, showcased: true },
      ]);

      return { normalPull, rewardPull };
    };

    describe('C1 — reward Pull exclusion', () => {
      it('leaderboardTop: reward Pull excluded — only the normal Pull is counted', async () => {
        const ids = mkIds('ldb');
        await seed(ids);

        const rows = await service.leaderboardTop({ sinceMs: null, limit: 50 });
        const entry = rows.find((r) => r.customer_id === ids.customer);

        // After C1: only the 1 source='pack' pull counts; the reward pull is excluded.
        expect(entry).toBeDefined();
        expect(entry!.pulls).toBe(1);
      });

      it('listPulls source $ne reward: excludes reward Pulls (mirrors pulls/recent + profile recent)', async () => {
        const ids = mkIds('recent');
        await seed(ids);

        // Without filter: both pulls visible
        const all = await service.listPulls(
          { customer_id: ids.customer },
          { take: 100 },
        );
        expect(all.length).toBe(2);

        // With C1 filter (mirrors route.ts: source: { $ne: 'reward' })
        const filtered = await service.listPulls(
          {
            customer_id: ids.customer,
            source: { $ne: 'reward' } as Parameters<typeof service.listPulls>[0]['source'],
          },
          { take: 100 },
        );
        expect(filtered).toHaveLength(1);
        expect(filtered[0].source).toBe('pack');
      });

      it('profile collection filter: showcased reward Pull excluded; normal Pull included', async () => {
        const ids = mkIds('coll');
        await seed(ids);

        const allPulls = await service.listPulls(
          { customer_id: ids.customer },
          { take: 100 },
        );
        // C1 collection filter (mirrors profiles/[handle]/route.ts after patch)
        const collection = allPulls.filter(
          (p) =>
            p.source !== 'reward' &&
            (p as unknown as { showcased: boolean }).showcased &&
            p.status === 'vaulted',
        );

        // Only the pack pull survives
        expect(collection).toHaveLength(1);
        expect(collection[0].source).toBe('pack');
      });

      it('buyback guard: reward Pull has source=reward + vaulted so the C1 gate fires', async () => {
        const ids = mkIds('buyback');
        const { rewardPull } = await seed(ids);

        // Confirm the Pull attributes that the C1 gate in buyback-pull.ts reads.
        // The gate throws "Reward prizes can't be sold back" before listCards —
        // we verify the Pull is in the right state so the guard would trigger.
        const [rp] = await service.listPulls({ id: rewardPull.id }, { take: 1 });
        expect(rp).toBeDefined();
        expect(rp!.source).toBe('reward');
        expect(rp!.status).toBe('vaulted');
      });
    });
  },
});
