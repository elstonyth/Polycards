/**
 * C1 — Exclude reward Pulls from 4 read sites (integration:modules)
 *
 * Extended by the free welcome pack (2026-08-14): 'free' pulls are excluded from
 * exactly the same read sites as 'reward' ones, and the free pack itself is
 * hidden from the public catalog like a reward_box.
 *
 * Asserted contracts:
 *  - leaderboardTop: reward AND free Pulls excluded from COUNT (source = 'pack'
 *    in raw SQL).
 *  - listPulls with source { $nin: ['reward', 'free'] }: excludes both (mirrors
 *    the pulls/recent route filter).
 *  - profile collection: showcased reward/free Pulls excluded by the source filter.
 *  - GET /store/packs: an ACTIVE free_welcome pack is absent from the catalog body.
 *  - backfillRecordedPullValues: a free Pull keeps recorded_value_usd NULL even
 *    though its card exists — without that, the next backfill run would stamp a
 *    live value on it and the COALESCE fallback would put it back on every board.
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
import { FREE_WELCOME_CATEGORY } from '../free-pack';
import {
  GET as catalogGET,
  clearPackListCache,
} from '../../../api/store/packs/route';
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
    // Each test gets unique IDs to avoid unique-constraint conflicts.
    const mkIds = (tag: string) => ({
      customer: `cus_c1_${tag}`,
      cardHandle: `card-c1-${tag}`,
      packSlug: `pack-c1-${tag}`,
      rewardPackSlug: `reward-box-c1-${tag}`,
      freePackSlug: `free-welcome-c1-${tag}`,
      prizeHandle: `prize-c1-${tag}`,
    });

    // Seed: normal card pack + reward_box pack + ACTIVE free_welcome pack + card
    // + PackOdds + one normal Pull (source='pack', vaulted, showcased) + one
    // reward Pull (source='reward', vaulted) + one free Pull (source='free',
    // vaulted, showcased, pointing at the REAL card so the backfill assertion
    // isn't vacuously satisfied by the batch CTE's JOIN card). Returns all three.
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
      await service.createPacks([
        {
          slug: ids.freePackSlug,
          title: 'C1 Free Welcome Pack',
          image: 'img.png',
          category: FREE_WELCOME_CATEGORY,
          status: 'active',
          price: 0,
          buyback_percent: 90,
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

      // leaderboardTop ranks by real spend (credit_transaction, reason=
      // 'pack_open'), not by Pull count — in production every Pull is preceded
      // by this charge (the open-pack charge step writes it with pull_id null;
      // pull_id is buyback linkage only). Seed it so the customer surfaces in
      // the spend-anchored CTE the query joins against.
      await service.createCreditTransactions([
        {
          customer_id: ids.customer,
          amount: -10, // matches packSlug's price
          reason: 'pack_open' as const,
          pull_id: null,
        },
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

      const [freePull] = await service.createPulls([
        {
          customer_id: ids.customer,
          pack_id: ids.freePackSlug,
          card_id: ids.cardHandle, // a REAL card — see the seed comment
          order_id: null,
          rolled_at: new Date(),
          source: 'free',
        },
      ]);
      await service.updatePulls([
        { id: freePull.id, status: 'vaulted' as const, showcased: true },
      ]);

      return { normalPull, rewardPull, freePull };
    };

    describe('C1 — reward Pull exclusion', () => {
      it('leaderboardTop: reward AND free Pulls excluded — only the normal Pull is counted', async () => {
        const ids = mkIds('ldb');
        await seed(ids);

        const rows = await service.leaderboardTop({ sinceMs: null, limit: 50 });
        const entry = rows.find((r) => r.customer_id === ids.customer);

        // Only the 1 source='pack' pull counts; reward + free are excluded.
        expect(entry).toBeDefined();
        expect(entry!.pulls).toBe(1);
      });

      it('challengeWeekTop: reward AND free Pulls excluded from the weekly count', async () => {
        const ids = mkIds('chal');
        await seed(ids);

        // Monday-reset KL week — the current week always contains "now", so the
        // just-seeded pulls are inside the window.
        const rows = await service.challengeWeekTop({
          timezone: 'Asia/Kuala_Lumpur',
          resetDay: 1,
          resetHour: 0,
          limit: 100,
        });
        const entry = rows.find((r) => r.customer_id === ids.customer);

        expect(entry).toBeDefined();
        expect(entry!.pulls).toBe(1);
      });

      it('listPulls source $nin [reward, free]: excludes both (mirrors pulls/recent)', async () => {
        const ids = mkIds('recent');
        await seed(ids);

        // Without filter: all three pulls visible
        const all = await service.listPulls(
          { customer_id: ids.customer },
          { take: 100 },
        );
        expect(all.length).toBe(3);

        // With the feed filter (mirrors pulls/recent/route.ts)
        const filtered = await service.listPulls(
          {
            customer_id: ids.customer,
            source: { $nin: ['reward', 'free'] } as Parameters<
              typeof service.listPulls
            >[0]['source'],
          },
          { take: 100 },
        );
        expect(filtered).toHaveLength(1);
        expect(filtered[0].source).toBe('pack');
      });

      it('profile collection filter: showcased reward/free Pulls excluded; normal Pull included', async () => {
        const ids = mkIds('coll');
        await seed(ids);

        const allPulls = await service.listPulls(
          { customer_id: ids.customer },
          { take: 100 },
        );
        // Collection filter (mirrors profiles/[handle]/route.ts, which filters
        // POSITIVELY on source='pack' — free/reward can never leak in).
        const collection = allPulls.filter(
          (p) =>
            p.source === 'pack' &&
            (p as unknown as { showcased: boolean }).showcased &&
            p.status === 'vaulted',
        );

        // Only the pack pull survives
        expect(collection).toHaveLength(1);
        expect(collection[0].source).toBe('pack');
      });

      it('GET /store/packs: an ACTIVE free_welcome pack is absent from the catalog', async () => {
        const ids = mkIds('catalog');
        await seed(ids);
        clearPackListCache(); // module state outlives a test's fixtures

        let body: { packs: { slug: string }[] } | undefined;
        await catalogGET(
          { scope: { resolve: () => service } } as never,
          { json: (b: unknown) => (body = b as typeof body) } as never,
        );

        const slugs = (body?.packs ?? []).map((p) => p.slug);
        // Control: the ordinary active pack IS listed, so an empty catalog
        // can't make this pass vacuously.
        expect(slugs).toContain(ids.packSlug);
        expect(slugs).not.toContain(ids.freePackSlug);
        expect(slugs).not.toContain(ids.rewardPackSlug);
      });

      it('backfillRecordedPullValues: stamps the pack Pull, leaves the free Pull NULL', async () => {
        const ids = mkIds('backfill');
        const { normalPull, freePull } = await seed(ids);

        await service.backfillRecordedPullValues();

        // Control: the free pull points at the SAME card as the pack pull, so a
        // non-null here proves the batch CTE reached that card and the NULL
        // below is the source filter, not a missing JOIN row.
        const [np] = await service.listPulls({ id: normalPull.id }, { take: 1 });
        expect(Number(np!.recorded_value_usd)).toBeGreaterThan(0);

        const [fp] = await service.listPulls({ id: freePull.id }, { take: 1 });
        expect(fp!.recorded_value_usd).toBeNull();
      });

      it('reward Pull is minted source=reward + vaulted (excluded from boards, sellable like any card)', async () => {
        const ids = mkIds('buyback');
        const { rewardPull } = await seed(ids);

        // `source` is what the board/feed exclusions above key off. It is NOT
        // a sell gate any more: the old C1 refusal in buyback-pull.ts went on
        // 2026-09-03 (free-pull-lock.integration.spec.ts covers the sell).
        const [rp] = await service.listPulls({ id: rewardPull.id }, { take: 1 });
        expect(rp).toBeDefined();
        expect(rp!.source).toBe('reward');
        expect(rp!.status).toBe('vaulted');
      });
    });
  },
});
