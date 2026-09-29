import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import { CONFIG_AUDIT_REASON } from '../../../modules/packs/config-audit';
import { updatePackInvoke } from '../update-pack';
import { createPackInvoke } from '../create-pack';
import { deletePackInvoke } from '../delete-pack';
import { reorderPacksInvoke } from '../reorder-packs';

// Every pack-settings change carries its own before/after audit row out of the
// change step; the workflow writes it as its last step (record-admin-audit).

const STORED = {
  id: 'pack_1',
  slug: 'bronze-pack',
  title: 'Bronze Pack',
  category: 'pokemon',
  status: 'draft' as const,
  price: 300,
  image: '/b.webp',
  display_image: null,
  buyback_percent: 90,
  target_rtp_bps: 7000,
  boost: false,
  rank: 1,
  published_odds: null,
  tier_ranges: null,
};

const WRITE = {
  slug: 'bronze-pack',
  title: 'Bronze Pack',
  category: 'pokemon',
  price: 300,
  image: '/b.webp',
  buyback_percent: 90,
  boost: false,
  rank: 1,
  status: 'draft' as const,
  admin_id: 'user_admin',
};

const containerWith = (packs: object) =>
  ({
    resolve: (key: string) => {
      if (key === PACKS_MODULE) return packs;
      throw new Error(`unexpected resolve ${key}`);
    },
  }) as unknown as MedusaContainer;

describe('update-pack audit', () => {
  it('records the buyback rate before and after, attributed to the admin', async () => {
    const packs = {
      listPacks: jest.fn().mockResolvedValue([STORED]),
      updatePacks: jest.fn().mockResolvedValue([]),
    };
    const res = await updatePackInvoke(
      { ...WRITE, buyback_percent: 100 },
      { container: containerWith(packs) },
    );
    const { audit } = res.output as { audit: Record<string, unknown> };
    expect(audit).toMatchObject({
      admin_id: 'user_admin',
      entity_type: 'pack',
      entity_id: 'bronze-pack',
      action: 'edit',
      reason: CONFIG_AUDIT_REASON,
    });
    expect((audit.before as { buyback_percent: number }).buyback_percent).toBe(
      90,
    );
    expect((audit.after as { buyback_percent: number }).buyback_percent).toBe(
      100,
    );
  });

  it('records nothing when the save changed nothing', async () => {
    const packs = {
      listPacks: jest.fn().mockResolvedValue([STORED]),
      updatePacks: jest.fn().mockResolvedValue([]),
    };
    const res = await updatePackInvoke(WRITE, {
      container: containerWith(packs),
    });
    expect((res.output as { audit: unknown }).audit).toBeNull();
  });
});

describe('create-pack audit', () => {
  it('records the new pack settings with no before', async () => {
    const packs = {
      listPacks: jest.fn().mockResolvedValue([]),
      createPacks: jest.fn(async ([p]: [Record<string, unknown>]) => [
        { id: 'pack_new', target_rtp_bps: 7000, ...p },
      ]),
    };
    const res = await createPackInvoke(
      { ...WRITE, buyback_percent: 95 },
      { container: containerWith(packs) },
    );
    const { audit } = res.output as { audit: Record<string, unknown> };
    expect(audit).toMatchObject({
      action: 'create',
      entity_id: 'bronze-pack',
      before: null,
    });
    expect((audit.after as { buyback_percent: number }).buyback_percent).toBe(
      95,
    );
  });
});

describe('delete-pack audit', () => {
  it('records the pack and its whole odds table as they stood', async () => {
    const odds = [
      {
        id: 'o1',
        pack_id: 'bronze-pack',
        card_id: 'card-a',
        rarity: 'Rare',
        weight: 600_000,
        weight_2: 500_000,
        weight_3: null,
        locked: false,
        top_hit_order: 1,
      },
      {
        id: 'o2',
        pack_id: 'bronze-pack',
        card_id: 'card-b',
        rarity: 'Common',
        weight: 400_000,
        weight_2: null,
        weight_3: null,
        locked: false,
        top_hit_order: null,
      },
    ];
    const packs = {
      listPacks: jest.fn().mockResolvedValue([STORED]),
      listPackOdds: jest.fn(async (_f: unknown, opts?: { skip?: number }) =>
        (opts?.skip ?? 0) > 0 ? [] : odds,
      ),
      listPulls: jest.fn().mockResolvedValue([]),
      deletePackOdds: jest.fn(),
      deletePacks: jest.fn(),
    };
    const res = await deletePackInvoke(
      { slug: 'bronze-pack', admin_id: 'user_admin' },
      { container: containerWith(packs) },
    );
    const { audit } = res.output as { audit: Record<string, unknown> };
    expect(audit).toMatchObject({ action: 'delete', after: null });
    const before = audit.before as {
      pack: { buyback_percent: number };
      odds: { card_id: string; weight_2: number | null }[];
    };
    expect(before.pack.buyback_percent).toBe(90);
    expect(before.odds.map((o) => [o.card_id, o.weight_2])).toEqual([
      ['card-a', 500_000],
      ['card-b', null],
    ]);
  });

  it('keeps set-2/3 weights and Top Hits in the rollback snapshot', async () => {
    const odds = [
      {
        id: 'o1',
        pack_id: 'bronze-pack',
        card_id: 'card-a',
        rarity: 'Rare',
        weight: 1_000_000,
        weight_2: 800_000,
        weight_3: 700_000,
        locked: false,
        top_hit_order: 3,
        kind: null,
        product_handle: null,
        credit_amount: null,
      },
    ];
    const packs = {
      listPacks: jest.fn().mockResolvedValue([STORED]),
      listPackOdds: jest.fn(async (_f: unknown, opts?: { skip?: number }) =>
        (opts?.skip ?? 0) > 0 ? [] : odds,
      ),
      deletePackOdds: jest.fn(),
      deletePacks: jest.fn(),
    };
    const res = await deletePackInvoke(
      { slug: 'bronze-pack', admin_id: 'user_admin' },
      { container: containerWith(packs) },
    );
    const comp = res.compensateInput as {
      odds: {
        weight_2: number | null;
        weight_3: number | null;
        top_hit_order: number | null;
      }[];
    };
    expect(comp.odds[0]).toMatchObject({
      weight_2: 800_000,
      weight_3: 700_000,
      top_hit_order: 3,
    });
  });
});

describe('reorder-packs audit', () => {
  it('records the ranks that moved', async () => {
    const packs = {
      listPacks: jest.fn().mockResolvedValue([
        { id: 'p1', slug: 'a', rank: 0 },
        { id: 'p2', slug: 'b', rank: 1 },
      ]),
      updatePacks: jest.fn(),
    };
    const res = await reorderPacksInvoke(
      {
        order: [
          { slug: 'b', rank: 0 },
          { slug: 'a', rank: 1 },
        ],
        admin_id: 'user_admin',
      },
      { container: containerWith(packs) },
    );
    const { audit } = res.output as { audit: Record<string, unknown> };
    expect(audit).toMatchObject({
      action: 'reorder',
      before: { ranks: { a: 0, b: 1 } },
      after: { ranks: { a: 1, b: 0 } },
    });
  });
});
