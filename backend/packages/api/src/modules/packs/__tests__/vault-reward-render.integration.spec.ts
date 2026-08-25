/**
 * Reward pulls render in the private vault on the CARD path.
 *
 * History: this spec was written for C2, when a reward pull could be a daily-box
 * product prize with no Card row behind it, so the vault rendered it from
 * reward_draw.prize_snapshot on a separate branch. The daily box was removed
 * 2026-08-25 and reward_draw with it. Every surviving source='reward' pull —
 * weekly-challenge prizes and task rewards alike — carries a real card handle,
 * so the branch is gone and this spec now pins the replacement contract:
 *
 *   - a reward pull appears in GET /store/vault,
 *   - with its Card sub-object (title/image come from the card, not a snapshot),
 *   - carrying source='reward',
 *   - and it is NOT dropped by the `if (!card) return null` normal-card guard.
 *
 * The regression this guards is the one that has bitten twice: a won or granted
 * card rendering as NOTHING in the owner's vault.
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
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';
import VipMemberState from '../models/vip-member-state';
import VipRewardGrant from '../models/vip-reward-grant';
import NotificationRead from '../models/notification-read';

// Import the vault route handler under test
import { GET as vaultGET } from '../../../api/store/vault/route';

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
    CustomerAccountState,
    AdminActionAudit,
    VipMemberState,
    VipRewardGrant,
    NotificationRead,
  ],
  testSuite: ({ service }) => {
    const mkIds = (tag: string) => ({
      customer: `cus_c2_${tag}`,
      cardHandle: `card-c2-${tag}`,
      packSlug: `pack-c2-${tag}`,
      prizeHandle: `prize-c2-${tag}`,
    });

    /**
     * Seed: one Pack, two Cards, one normal vaulted Pack Pull, and one reward
     * vaulted Pull on the 'task-reward' sentinel pack — the shape claimTask
     * writes for a card reward, and the shape with no pack row and no odds rows
     * behind it.
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
        {
          handle: ids.prizeHandle,
          name: 'C2 Prize Card',
          set: 'Base',
          grader: 'PSA',
          grade: '9',
          market_value: 35,
          image: 'prize.png',
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
        { id: normalPull.id, status: 'vaulted' as const },
      ]);

      const [rewardPull] = await service.createPulls([
        {
          customer_id: ids.customer,
          // The sentinel claimTask writes for a card reward: no Pack row, no
          // odds rows. The vault must cope with both.
          pack_id: 'task-reward',
          card_id: ids.prizeHandle,
          order_id: null,
          rolled_at: new Date(),
          source: 'reward',
        },
      ]);
      await service.updatePulls([
        { id: rewardPull.id, status: 'vaulted' as const },
      ]);

      return { normalPull, rewardPull };
    };

    // Build a minimal mock req/res pair to invoke the vault route handler
    const callVaultRoute = async (customerId: string) => {
      const captured: Record<string, unknown> = {};
      const res = {
        json: (body: unknown) => {
          captured.body = body;
        },
      };
      const req = {
        auth_context: { actor_id: customerId },
        scope: {
          resolve: (_name: string) => service,
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await vaultGET(req as any, res as any);
      return captured.body as { items: unknown[] };
    };

    describe('reward pulls in GET /store/vault', () => {
      it('renders a reward pull from its Card, not from a prize snapshot', async () => {
        const ids = mkIds('route');
        const { rewardPull } = await seed(ids);

        const body = await callVaultRoute(ids.customer);
        const items = body.items as Array<Record<string, unknown>>;

        const rewardItem = items.find((i) => i.pull_id === rewardPull.id);
        expect(rewardItem).toBeDefined();
        expect(rewardItem!.source).toBe('reward');
        const card = rewardItem!.card as Record<string, unknown>;
        expect(card).toBeDefined();
        expect(card.handle).toBe(ids.prizeHandle);
        expect(card.name).toBe('C2 Prize Card');
        // A sentinel pack has no odds rows, so nothing can be inferred from
        // them — but the item must still be present and rendered.
        expect(rewardItem!.locked).toBe(false);
      });

      it('normal-card vault rows unchanged — still rendered with card + buyback', async () => {
        const ids = mkIds('normal');
        const { normalPull } = await seed(ids);

        const body = await callVaultRoute(ids.customer);
        const items = body.items as Array<Record<string, unknown>>;

        const normalItem = items.find((i) => i.pull_id === normalPull.id);
        expect(normalItem).toBeDefined();
        expect((normalItem!.card as Record<string, unknown>).handle).toBe(
          ids.cardHandle,
        );
        expect(normalItem!.buyback).toBeDefined();
        // Free-welcome pack (Task 7): EVERY vault item states how it was
        // acquired and whether it is locked.
        expect(normalItem!.source).toBe('pack');
        expect(normalItem!.locked).toBe(false);
      });
    });
  },
});
