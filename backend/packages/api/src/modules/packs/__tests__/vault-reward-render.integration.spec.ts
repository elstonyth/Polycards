/**
 * C2 — Include reward Pulls in the private vault (render from prize_snapshot)
 *
 * The vault route (GET /store/vault) must show reward Pulls with title/image
 * from the reward_draw.prize_snapshot keyed by vault_pull_id, and must NOT
 * drop them via the `if (!card) return null` normal-card guard.
 *
 * Step 1 (failing): The vault route handler is invoked with a mock request
 * carrying a reward Pull (source='reward', no Card row). Before C2 the
 * `if (!card) return null` guard drops it → items is empty. Test asserts the
 * reward item IS present → fails until the route is fixed.
 *
 * Step 2 (implementation): Branch on Pull.source in the vault route. For
 * source==='reward', load the matching reward_draw by vault_pull_id, use
 * prize_snapshot.{title,image}, omit the buyback block.
 *
 * Execution model: moduleIntegrationTestRunner — schema from MODEL definitions;
 * hand-written CHECKs/partial-unique absent; runtime logic only.
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

// Import the vault route handler under test
import { GET as vaultGET } from '../../../api/store/vault/route';

jest.setTimeout(300 * 1000);

const today = () => new Date().toISOString().slice(0, 10);

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
    const mkIds = (tag: string) => ({
      customer: `cus_c2_${tag}`,
      cardHandle: `card-c2-${tag}`,
      packSlug: `pack-c2-${tag}`,
      rewardPackSlug: `reward-box-c2-${tag}`,
      prizeHandle: `prize-c2-${tag}`,
    });

    /**
     * Seed: a normal card Pack + a reward_box Pack, one Card row, one normal
     * vaulted Pack Pull, one reward vaulted Pull (card_id = prizeHandle sentinel,
     * no Card row), and a matching RewardDraw row with vault_pull_id set.
     */
    const seed = async (ids: ReturnType<typeof mkIds>) => {
      await service.createPacks([
        {
          slug: ids.packSlug,
          title: 'C2 Normal Pack',
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
          title: 'C2 Reward Box',
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
          name: 'C2 Card',
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

      // Normal pack Pull (source='pack', card row exists)
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
      await service.updatePulls([{ id: normalPull.id, status: 'vaulted' as const }]);

      // Reward Pull (source='reward', card_id = product handle sentinel, NO Card row)
      const [rewardPull] = await service.createPulls([
        {
          customer_id: ids.customer,
          pack_id: ids.rewardPackSlug,
          card_id: ids.prizeHandle,
          order_id: null,
          rolled_at: new Date(),
          source: 'reward',
        },
      ]);
      await service.updatePulls([{ id: rewardPull.id, status: 'vaulted' as const }]);

      // Matching RewardDraw row with vault_pull_id pointing at the reward Pull
      const prizeSnapshot = {
        product_handle: ids.prizeHandle,
        title: 'C2 Prize Title',
        image: 'https://cdn.example.com/c2-prize.png',
      };
      await service.createRewardDraws([
        {
          customer_id: ids.customer,
          tier: 'c',
          draw_day: today(),
          draw_ordinal: 1,
          prize_kind: 'product',
          prize_snapshot: prizeSnapshot,
          vault_pull_id: rewardPull.id,
          credit_txn_id: null,
          status: 'drawn',
        },
      ]);

      return { normalPull, rewardPull, prizeSnapshot };
    };

    // Build a minimal mock req/res pair to invoke the vault route handler
    const callVaultRoute = async (customerId: string) => {
      const captured: Record<string, unknown> = {};
      const res = {
        json: (body: unknown) => { captured.body = body; },
      };
      const req = {
        auth_context: { actor_id: customerId },
        scope: {
          resolve: (_name: string) => service,
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await vaultGET(req as any, res as any);
      return (captured.body as { items: unknown[] });
    };

    describe('C2 — reward Pull vault render', () => {
      it('STEP1 (was failing before C2): reward Pull appears in GET /store/vault with snapshot title+image', async () => {
        const ids = mkIds('route');
        const { rewardPull } = await seed(ids);

        const body = await callVaultRoute(ids.customer);
        const items = body.items as Array<Record<string, unknown>>;

        // After C2: reward Pull must appear in the vault response
        const rewardItem = items.find(
          (i) => i.pull_id === rewardPull.id,
        );
        expect(rewardItem).toBeDefined();
        expect(rewardItem!.title).toBe('C2 Prize Title');
        expect(rewardItem!.image).toBe('https://cdn.example.com/c2-prize.png');
        expect(rewardItem!.source).toBe('reward');
        // No buyback block on reward items
        expect(rewardItem!.buyback).toBeUndefined();
      });

      it('normal-card vault rows unchanged — still rendered with card + buyback', async () => {
        const ids = mkIds('normal');
        const { normalPull } = await seed(ids);

        const body = await callVaultRoute(ids.customer);
        const items = body.items as Array<Record<string, unknown>>;

        const normalItem = items.find((i) => i.pull_id === normalPull.id);
        expect(normalItem).toBeDefined();
        // Normal pull has a card sub-object and a buyback block
        expect(normalItem!.card).toBeDefined();
        expect((normalItem!.card as Record<string, unknown>).handle).toBe(ids.cardHandle);
        expect(normalItem!.buyback).toBeDefined();
        expect(normalItem!.source).toBeUndefined(); // source not exposed in normal vault shape
      });

      it('reward Pull has a matching RewardDraw with prize_snapshot.{title,image}', async () => {
        const ids = mkIds('snapshot');
        const { rewardPull, prizeSnapshot } = await seed(ids);

        const draws = await service.listRewardDraws(
          { vault_pull_id: rewardPull.id },
          { take: 1 },
        );
        expect(draws).toHaveLength(1);
        const snap = draws[0].prize_snapshot as typeof prizeSnapshot;
        expect(snap.title).toBe('C2 Prize Title');
        expect(snap.image).toBe('https://cdn.example.com/c2-prize.png');
      });
    });
  },
});
