import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import { savePackOddsInvoke } from '../save-pack-odds';
import { setPackMembersInvoke } from '../set-pack-members';
import { deleteCardInvoke } from '../delete-card';

jest.mock('../../../api/admin/media/bake-slab', () => ({
  deleteSlabFile: jest.fn(),
  mirrorSlabToProduct: jest.fn(),
}));

// Every odds change carries its own before/after audit row out of the change
// step; the workflow writes it as its last step (record-admin-audit).

const PACK = {
  id: 'pack_1',
  slug: 'bronze-pack',
  status: 'draft',
  category: 'pokemon',
  target_rtp_bps: 7000,
};

const row = (
  card_id: string,
  rarity: string,
  weight: number,
  extra: Record<string, unknown> = {},
) => ({
  id: `o_${card_id}`,
  pack_id: PACK.slug,
  card_id,
  rarity,
  weight,
  weight_2: null,
  weight_3: null,
  locked: false,
  top_hit_order: null,
  ...extra,
});

const entry = (card_id: string, rarity: string, pct: number) => ({
  card_id,
  rarity,
  pct,
  locked: false,
  pct_2: null,
  pct_3: null,
});

const containerWith = (packs: object) =>
  ({
    resolve: (key: string) => (key === PACKS_MODULE ? packs : {}),
  }) as unknown as MedusaContainer;

// pageAll asks for successive pages; the stub answers the first one only.
const paged =
  <T>(rows: T[]) =>
  async (_f: unknown, opts?: { skip?: number }) =>
    (opts?.skip ?? 0) > 0 ? [] : rows;

describe('save-pack-odds audit', () => {
  const existing = [
    row('rare-a', 'Rare', 220_000),
    row('common-b', 'Common', 780_000),
  ];

  const packsWith = () => ({
    listPacks: jest.fn().mockResolvedValue([PACK]),
    listPackOdds: jest.fn(paged(existing)),
    updatePackOdds: jest.fn(),
    updatePacks: jest.fn(),
  });

  it('records the odds table before and after an edit', async () => {
    const packs = packsWith();
    const res = await savePackOddsInvoke(
      {
        pack_id: PACK.slug,
        entries: [entry('rare-a', 'Rare', 30), entry('common-b', 'Common', 0)],
        admin_id: 'user_admin',
      },
      { container: containerWith(packs) },
    );
    const { audit } = res.output as { audit: Record<string, unknown> };
    expect(audit).toMatchObject({
      admin_id: 'user_admin',
      entity_type: 'pack',
      entity_id: PACK.slug,
      action: 'edit_odds',
    });
    const weightOf = (side: unknown, id: string) =>
      (side as { odds: { card_id: string; weight: number }[] }).odds.find(
        (o) => o.card_id === id,
      )?.weight;
    expect(weightOf(audit.before, 'rare-a')).toBe(220_000);
    expect(weightOf(audit.after, 'rare-a')).toBe(300_000);
    expect(weightOf(audit.after, 'common-b')).toBe(700_000);
  });

  it('records nothing when the save left every weight as it was', async () => {
    const packs = packsWith();
    const res = await savePackOddsInvoke(
      {
        pack_id: PACK.slug,
        entries: [entry('rare-a', 'Rare', 22), entry('common-b', 'Common', 0)],
        admin_id: 'user_admin',
      },
      { container: containerWith(packs) },
    );
    expect((res.output as { audit: unknown }).audit).toBeNull();
  });

  it('writes the target RTP in the same step and records it', async () => {
    const packs = packsWith();
    const res = await savePackOddsInvoke(
      {
        pack_id: PACK.slug,
        entries: [entry('rare-a', 'Rare', 22), entry('common-b', 'Common', 0)],
        admin_id: 'user_admin',
        target_rtp_bps: 8000,
      },
      { container: containerWith(packs) },
    );
    expect(packs.updatePacks).toHaveBeenCalledWith([
      { id: PACK.id, target_rtp_bps: 8000 },
    ]);
    const { audit } = res.output as { audit: Record<string, unknown> };
    expect(audit.before).toMatchObject({ target_rtp_bps: 7000 });
    expect(audit.after).toMatchObject({ target_rtp_bps: 8000 });
    // Rollback restores the target it replaced.
    expect(res.compensateInput).toMatchObject({
      pack: { id: PACK.id, target_rtp_bps: 7000 },
    });
  });

  it('keeps the editor response unchanged', async () => {
    const packs = packsWith();
    const res = await savePackOddsInvoke(
      {
        pack_id: PACK.slug,
        entries: [entry('rare-a', 'Rare', 30), entry('common-b', 'Common', 0)],
        admin_id: 'user_admin',
      },
      { container: containerWith(packs) },
    );
    const { computed } = res.output as {
      computed: { card_id: string; pct: number }[];
    };
    expect(computed.find((c) => c.card_id === 'rare-a')?.pct).toBe(30);
  });
});

describe('set-pack-members audit', () => {
  it('records the pool before and after a card is added', async () => {
    const existing = [
      row('rare-a', 'Rare', 220_000),
      row('common-b', 'Common', 780_000),
    ];
    const packs = {
      listPacks: jest.fn().mockResolvedValue([{ ...PACK, status: 'draft' }]),
      listCards: jest.fn(async ({ handle }: { handle: string[] }) =>
        handle.map((h) => ({ handle: h })),
      ),
      listPackOdds: jest.fn(paged(existing)),
      applyPackMemberDiff: jest.fn(
        async (diff: { create: { card_id: string }[] }) => ({
          created_ids: diff.create.map((c) => `o_${c.card_id}`),
        }),
      ),
    };
    const res = await setPackMembersInvoke(
      {
        pack_id: PACK.slug,
        card_ids: ['rare-a', 'common-b', 'new-c'],
        admin_id: 'user_admin',
      },
      { container: containerWith(packs) },
    );
    const { audit } = res.output as { audit: Record<string, unknown> };
    expect(audit).toMatchObject({ action: 'edit_members' });
    const ids = (side: unknown) =>
      (side as { odds: { card_id: string }[] }).odds.map((o) => o.card_id);
    expect(ids(audit.before)).toEqual(['common-b', 'rare-a']);
    expect(ids(audit.after)).toEqual(['common-b', 'new-c', 'rare-a']);
    // The rows as written: the two Commons now split the balance.
    const after = (
      audit.after as { odds: { card_id: string; weight: number }[] }
    ).odds;
    expect(after.reduce((s, o) => s + o.weight, 0)).toBe(1_000_000);
  });
});

describe('delete-card audit', () => {
  const card = {
    id: 'card_1',
    handle: 'rare-a',
    name: 'Rare A',
    set: 'Base',
    grader: 'PSA',
    grade: '10',
    market_value: 100,
    image: '/a.webp',
    price: null,
    for_sale: true,
    slab_image: null,
    slab_image_key: null,
    pokemon_dex: null,
    sprite_image: null,
    pc_product_id: null,
    pc_grade: null,
    market_multiplier: 1.2,
    pc_synced_at: null,
  };
  const odds = [
    row('rare-a', 'Rare', 220_000, { weight_2: 400_000, weight_3: 500_000 }),
  ];
  const packsWith = () => ({
    listCards: jest.fn().mockResolvedValue([card]),
    listPulls: jest.fn().mockResolvedValue([]),
    listPackOdds: jest.fn(paged(odds)),
    deletePackOdds: jest.fn(),
    deleteCards: jest.fn(),
  });

  it('records the card and every odds row it held, attributed to the admin', async () => {
    const res = await deleteCardInvoke(
      { handle: 'rare-a', admin_id: 'user_admin' },
      { container: containerWith(packsWith()) },
    );
    const { audit } = res.output as { audit: Record<string, unknown> };
    expect(audit).toMatchObject({
      admin_id: 'user_admin',
      entity_type: 'card',
      entity_id: 'rare-a',
      action: 'delete',
      after: null,
    });
    expect(audit.before).toMatchObject({
      odds: [
        {
          pack_id: PACK.slug,
          card_id: 'rare-a',
          weight: 220_000,
          weight_2: 400_000,
          weight_3: 500_000,
        },
      ],
    });
  });

  it('keeps set-2/3 weights in the rollback snapshot', async () => {
    const res = await deleteCardInvoke(
      { handle: 'rare-a', admin_id: 'user_admin' },
      { container: containerWith(packsWith()) },
    );
    expect(
      (res.compensateInput as { odds: Record<string, unknown>[] }).odds[0],
    ).toMatchObject({ weight_2: 400_000, weight_3: 500_000 });
  });
});
