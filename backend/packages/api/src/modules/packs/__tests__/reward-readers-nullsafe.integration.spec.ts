/**
 * C3 — Null-safe confirm for card_id-keyed readers (spec §5.1 invariant)
 *
 * Seeds:
 *  - One reward PackOdds row (card_id=NULL, kind='credit') in a reward_box pack
 *  - One reward Pull (card_id='p-handle' sentinel, source='reward', vaulted)
 *    with a matching RewardDraw (prize_snapshot)
 *  - One normal Pack + Card + PackOdds + Pull (source='pack') so each reader
 *    has at least one normal row to exercise the JOIN path
 *
 * Asserts:
 *  1. GET /store/vault handler → 200 (no throw); reward item present; normal item
 *     present — null card_id PackOdds row does NOT crash the vault logic.
 *  2. listPulls with source.$ne filter → 200 (no throw); only normal pull returned
 *     (mirrors pulls/recent route); makeRarityOf on the resulting oddsRows (which
 *     may include a null-card_id row if queried broadly) does NOT throw.
 *  3. Profile-style aggregation (inline — avoids Modules.CUSTOMER cross-module dep):
 *     filter out reward pulls, then run cardIds / packIds / listPackOdds / makeRarityOf
 *     → no throw; stats + collection correct.
 *
 * Execution model: moduleIntegrationTestRunner — schema from MODEL definitions;
 * hand-written CHECKs / partial-unique absent; runtime logic only.
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

// Import route handlers under test (same pattern as C2)
import { GET as vaultGET } from '../../../api/store/vault/route';
import { GET as recentGET } from '../../../api/store/pulls/recent/route';
import { GET as profileGET } from '../../../api/store/profiles/[handle]/route';
import { makeRarityOf } from '../card-view';
import { Modules } from '@medusajs/framework/utils';

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
      customer: `cus_c3_${tag}`,
      cardHandle: `card-c3-${tag}`,
      packSlug: `pack-c3-${tag}`,
      rewardPackSlug: `reward-box-c3-${tag}`,
      prizeHandle: `prize-c3-${tag}`,
    });

    /**
     * Seed the full C3 scenario:
     *   - normal Pack + Card + PackOdds (card_id=cardHandle, kind=null legacy)
     *   - reward_box Pack + reward PackOdds (card_id=NULL, kind='credit')
     *   - normal Pull (source='pack', vaulted)
     *   - reward Pull (source='reward', card_id=prizeHandle sentinel, vaulted)
     *   - RewardDraw keyed to the reward Pull
     */
    const seed = async (ids: ReturnType<typeof mkIds>) => {
      await service.createPacks([
        {
          slug: ids.packSlug,
          title: 'C3 Normal Pack',
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
          title: 'C3 Reward Box',
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
          name: 'C3 Card',
          set: 'Base',
          grader: 'PSA',
          grade: '10',
          market_value: 20,
          image: 'card.png',
        },
      ]);

      // Normal (legacy) PackOdds row — card_id set, kind=null
      await service.createPackOdds([
        {
          pack_id: ids.packSlug,
          card_id: ids.cardHandle,
          rarity: 'Common',
          weight: 1,
        },
      ]);

      // Reward PackOdds row — card_id=NULL, kind='credit' (the null-sentinel case)
      // moduleIntegrationTestRunner has no hand-written CHECK so this saves fine.
      await service.createPackOdds([
        {
          pack_id: ids.rewardPackSlug,
          card_id: null,
          rarity: null,
          kind: 'credit',
          credit_amount: 5,
          weight: 1,
        } as Parameters<typeof service.createPackOdds>[0][number],
      ]);

      // Normal Pull
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

      // Reward Pull — card_id = product handle sentinel (not a Card row)
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

      // Matching RewardDraw with vault_pull_id
      const prizeSnapshot = {
        product_handle: ids.prizeHandle,
        title: 'C3 Prize',
        image: 'https://cdn.example.com/c3-prize.png',
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

    // Minimal mock req/res — same pattern as C2 vault test
    const callVaultRoute = async (customerId: string) => {
      const captured: Record<string, unknown> = {};
      const res = { json: (body: unknown) => { captured.body = body; } };
      const req = {
        auth_context: { actor_id: customerId },
        scope: { resolve: (_name: string) => service },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await vaultGET(req as any, res as any);
      return captured.body as { items: Array<Record<string, unknown>> };
    };

    // pulls/recent: unauthenticated; scope.resolve returns service
    const callRecentRoute = async () => {
      const captured: Record<string, unknown> = {};
      const res = { json: (body: unknown) => { captured.body = body; } };
      const req = {
        scope: { resolve: (_name: string) => service },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await recentGET(req as any, res as any);
      return captured.body as { pulls: Array<Record<string, unknown>> };
    };

    describe('C3 — card_id-keyed readers are null-safe for reward rows', () => {
      it('vault: reward Pull with card_id=prizeHandle sentinel → 200, no throw, both items returned', async () => {
        const ids = mkIds('vault');
        const { normalPull, rewardPull } = await seed(ids);

        // Must not throw
        const body = await callVaultRoute(ids.customer);
        const items = body.items;

        // Normal card pull is present
        expect(items.some((i) => i.pull_id === normalPull.id)).toBe(true);
        // Reward pull rendered from prize_snapshot (not dropped by card guard)
        const rewardItem = items.find((i) => i.pull_id === rewardPull.id);
        expect(rewardItem).toBeDefined();
        expect(rewardItem!.source).toBe('reward');
      });

      it('vault: listPackOdds with null-card_id row in DB — no crash in normal-pull path', async () => {
        const ids = mkIds('odds_null');
        await seed(ids);

        // The reward PackOdds row has card_id=NULL.
        // The vault route only queries listPackOdds({card_id: handles}) where handles
        // comes from normalPulls — the null row won't be in that result. Confirm the
        // null-card_id PackOdds row exists in the DB without crashing.
        const allOdds = await service.listPackOdds(
          { pack_id: ids.rewardPackSlug },
          { take: 10 },
        );
        expect(allOdds.length).toBeGreaterThanOrEqual(1);
        const nullRow = allOdds.find((o) => o.card_id === null);
        expect(nullRow).toBeDefined();
        expect(nullRow!.kind).toBe('credit');
      });

      it('makeRarityOf: a null-card_id odds row produces a key that misses, defaults to Common — no throw', () => {
        // Simulate a scenario where a null-card_id odds row somehow reaches makeRarityOf.
        // The key becomes "packslug null" which simply misses the lookup → defaults "Common".
        const oddsWithNull = [
          { pack_id: 'pack-a', card_id: null as unknown as string, rarity: 'Mythical' },
          { pack_id: 'pack-a', card_id: 'real-card', rarity: 'Rare' },
        ];
        // Must not throw
        const rarityOf = makeRarityOf(oddsWithNull);

        // The null row produces no useful key — lookup returns "Common" (the default)
        expect(rarityOf('pack-a', '')).toBe('Common');
        // A real row still resolves correctly
        expect(rarityOf('pack-a', 'real-card')).toBe('Rare');
      });

      it('pulls/recent: reward Pull excluded (source=$ne:reward), normal Pull included — no throw', async () => {
        const ids = mkIds('recent');
        const { normalPull } = await seed(ids);

        // Must not throw even though a null-card_id PackOdds row is in the DB
        const body = await callRecentRoute();
        const pulls = body.pulls;

        // Only pack-source pulls appear; reward Pull absent from recent feed
        // (card_id sentinel 'prize-c3-recent' has no Card row → filtered by !card check)
        // The normal pull's card DOES exist so it appears.
        expect(
          pulls.some((p) => p.pack_id === normalPull.pack_id),
        ).toBe(true);

        // No sentinel / reward handle in the feed
        expect(
          pulls.some((p) => p.handle === ids.prizeHandle),
        ).toBe(false);
      });

      it('profile-style aggregation: reward Pulls filtered before cardIds/listPackOdds — no throw, stats correct', async () => {
        const ids = mkIds('profile');
        await seed(ids);

        // Inline the profile route logic (avoids Modules.CUSTOMER cross-module dep)
        const allPulls = await service.listPulls(
          { customer_id: ids.customer },
          { take: 20000, order: { rolled_at: 'DESC' } },
        );

        // C1 filter: exclude reward pulls (mirrors profiles/[handle]/route.ts)
        const pulls = allPulls.filter((p) => p.source !== 'reward');
        expect(pulls).toHaveLength(1);
        expect(pulls[0].source).toBe('pack');

        // cardIds / packIds only include normal-pull handles — no prizeHandle sentinel
        const cardIds = [...new Set(pulls.map((p) => p.card_id))];
        const packIds = [...new Set(pulls.map((p) => p.pack_id))];
        expect(cardIds).not.toContain(ids.prizeHandle);

        // listPackOdds with the normal-pull cardIds — does NOT return the null-card_id row
        const odds =
          cardIds.length && packIds.length
            ? await service.listPackOdds(
                { pack_id: packIds, card_id: cardIds },
                { take: packIds.length * cardIds.length },
              )
            : [];

        // Must not throw; the null-card_id reward row is NOT in this result set
        expect(() => makeRarityOf(odds)).not.toThrow();
        const rarityOf = makeRarityOf(odds);
        // Normal pull's rarity resolves
        expect(rarityOf(ids.packSlug, ids.cardHandle)).toBe('Common');
        // Sentinel handle returns default (no crash)
        expect(rarityOf(ids.rewardPackSlug, ids.prizeHandle)).toBe('Common');
      });

      it('profile route handler: GET /store/profiles/:handle — no throw with reward Pulls in DB', async () => {
        const ids = mkIds('profilerte');
        await seed(ids);

        // Stub the Modules.CUSTOMER service: findCustomerByHandle calls
        // customers.listCustomers({metadata:{handle}},{take:1}). Return a
        // minimal customer so the route proceeds past the 404 guard. This lets
        // us call the actual GET handler without the real cross-module
        // ICustomerModuleService being present in moduleIntegrationTestRunner.
        //
        // The handle must satisfy HANDLE_RE (/^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/)
        // and must match the customer_id seeded above so listPulls returns the
        // correct rows.
        const testHandle = 'c3-profile-rt'; // valid HANDLE_RE shape
        const stubCustomer = {
          id: ids.customer, // same id used in seed() → listPulls hits the right rows
          first_name: 'C3Test',
          created_at: new Date().toISOString(),
          metadata: { handle: testHandle },
        };
        // ponytail: minimal stub — only the methods findCustomerByHandle calls
        const stubCustomerModule = {
          listCustomers: async () => [stubCustomer],
        };

        const captured: Record<string, unknown> = {};
        const res = { json: (body: unknown) => { captured.body = body; } };
        const req = {
          params: { handle: testHandle },
          scope: {
            resolve: (name: string) => {
              if (name === Modules.CUSTOMER) return stubCustomerModule;
              return service; // PACKS_MODULE + anything else → real service
            },
          },
        };

        // Must not throw even though a reward Pull (source='reward',
        // card_id=prizeHandle sentinel) and a null-card_id PackOdds row
        // both exist for this customer in the DB.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await profileGET(req as any, res as any);

        const body = captured.body as {
          stats: { pulls: number };
          recent: unknown[];
          collection: unknown[];
        };
        // Only the one normal (non-reward) pull counts in public stats
        expect(body.stats.pulls).toBe(1);
        // recent feed has the normal pull's card (reward pull excluded by C1 filter)
        expect(body.recent).toHaveLength(1);
        // collection empty (showcased not set in seed)
        expect(body.collection).toHaveLength(0);
      });
    });
  },
});
