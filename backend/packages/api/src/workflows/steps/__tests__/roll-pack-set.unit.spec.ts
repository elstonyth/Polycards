import { MedusaError } from '@medusajs/framework/utils';
import { fetchPackData, drawFromData, rollOne } from '../roll-pack';

// Odds-set resolution at the DRAW boundary (§2.5). fetchPackData resolves each
// row's weight for the customer's set ONCE, so pickWonRow / drawFromData and
// every consumer below keep seeing a plain `weight`. These specs pin that the
// resolution happens there (not in pick.ts) and that the fallback chain
// (set 3 → set 2 → set 1) is applied per row, not per pack.

const PACK = { id: 'pack_1', slug: 'test-pack', status: 'active', price: 5 };

// set 1: 7000 / 3000 / 1000 → 11000
// set 2: 4000 / 6000 / 1000 (mew's set 2 is empty → set 1) → 11000
// set 3: 4000 (empty → set 2) / 500 / 1000 (empty → empty → set 1) → 5500
const ODDS = [
  {
    id: 'o1',
    pack_id: 'test-pack',
    card_id: 'pikachu',
    rarity: 'common',
    weight: 7000,
    weight_2: 4000,
    weight_3: null,
  },
  {
    id: 'o2',
    pack_id: 'test-pack',
    card_id: 'charizard',
    rarity: 'rare',
    weight: 3000,
    weight_2: 6000,
    weight_3: 500,
  },
  {
    id: 'o3',
    pack_id: 'test-pack',
    card_id: 'mew',
    rarity: 'rare',
    weight: 1000,
    weight_2: null,
    weight_3: null,
  },
  // Reward row (card_id null) — filtered out before resolution on every set.
  {
    id: 'r1',
    pack_id: 'test-pack',
    card_id: null,
    rarity: null,
    weight: 9999,
    weight_2: 9999,
    weight_3: 9999,
  },
];

const CARD = {
  handle: 'pikachu',
  name: 'Pikachu',
  set: 'Base',
  grader: 'PSA',
  grade: '9',
  market_value: 10,
  image: '/pikachu.webp',
  pokemon_dex: 25,
  sprite_image: '/sprites/25.png',
  slab_image: null,
};

function buildPacks(overrides?: {
  listPackOdds?: jest.Mock;
  listCards?: jest.Mock;
}) {
  return {
    listPacks: jest.fn().mockResolvedValue([PACK]),
    listPackOdds: overrides?.listPackOdds ?? jest.fn().mockResolvedValue(ODDS),
    // Echoes back whichever card won so a draw can be asserted by handle.
    listCards:
      overrides?.listCards ??
      jest
        .fn()
        .mockImplementation(({ handle }: { handle: string }) =>
          Promise.resolve([{ ...CARD, handle, name: handle }]),
        ),
  } as unknown as Parameters<typeof fetchPackData>[0];
}

const weights = (d: Awaited<ReturnType<typeof fetchPackData>>) =>
  d.odds.map((o) => o.weight);

describe('fetchPackData — odds-set resolution', () => {
  it('defaults to set 1 (unchanged behavior for every existing caller)', async () => {
    const data = await fetchPackData(buildPacks(), 'test-pack');
    expect(weights(data)).toEqual([7000, 3000, 1000]);
    expect(data.totalWeight).toBe(11000);
  });

  it('maps every row through the set-2 chain and totals the RESOLVED weights', async () => {
    const data = await fetchPackData(buildPacks(), 'test-pack', 2);
    // mew has no set-2 weight → inherits set 1 (1000), per-row not per-pack.
    expect(weights(data)).toEqual([4000, 6000, 1000]);
    expect(data.totalWeight).toBe(11000);
  });

  it('maps every row through the set-3 chain (3 → 2 → 1)', async () => {
    const data = await fetchPackData(buildPacks(), 'test-pack', 3);
    // pikachu: set 3 empty → set 2 (4000). charizard: explicit 500.
    // mew: set 3 and set 2 empty → set 1 (1000).
    expect(weights(data)).toEqual([4000, 500, 1000]);
    expect(data.totalWeight).toBe(5500);
  });

  it('drops reward rows (card_id null) before resolving, on every set', async () => {
    for (const set of [1, 2, 3] as const) {
      const data = await fetchPackData(buildPacks(), 'test-pack', set);
      expect(data.odds).toHaveLength(3);
      expect(data.odds.every((o) => o.card_id != null)).toBe(true);
    }
  });

  it('throws NOT_ALLOWED when the RESOLVED set has no positive weight', async () => {
    // Set 1 is fine (100), but set 2 zeroes the only card out — the guard must
    // run against the set actually being rolled, not against set 1.
    const listPackOdds = jest.fn().mockResolvedValue([
      {
        id: 'o1',
        pack_id: 'test-pack',
        card_id: 'pikachu',
        rarity: 'common',
        weight: 100,
        weight_2: 0,
        weight_3: null,
      },
    ]);
    await expect(
      fetchPackData(buildPacks({ listPackOdds }), 'test-pack', 2),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
    // Same pack on set 1 rolls fine.
    await expect(
      fetchPackData(buildPacks({ listPackOdds }), 'test-pack', 1),
    ).resolves.toMatchObject({ totalWeight: 100 });
  });
});

describe('draw path — the resolved set decides the winner', () => {
  it('the SAME roll picks a different card on set 1 vs set 3', async () => {
    const packs = buildPacks();
    const set1 = await fetchPackData(packs, 'test-pack', 1);
    const set3 = await fetchPackData(packs, 'test-pack', 3);

    // roll 4200: set 1 cumulative [0,7000) → pikachu.
    //            set 3 cumulative [0,4000) pikachu, [4000,4500) charizard.
    const a = await drawFromData(packs, set1.odds, set1.totalWeight, 4200);
    const b = await drawFromData(packs, set3.odds, set3.totalWeight, 4200);
    expect(a.handle).toBe('pikachu');
    expect(b.handle).toBe('charizard');
  });

  it('rollOne threads the set down to the draw (single-open path)', async () => {
    // Degenerate weights make the winner deterministic without an injected roll:
    // set 1 gives pikachu all the weight, set 2 gives it all to charizard.
    const listPackOdds = jest.fn().mockResolvedValue([
      {
        id: 'o1',
        pack_id: 'test-pack',
        card_id: 'pikachu',
        rarity: 'common',
        weight: 10000,
        weight_2: 0,
        weight_3: null,
      },
      {
        id: 'o2',
        pack_id: 'test-pack',
        card_id: 'charizard',
        rarity: 'rare',
        weight: 0,
        weight_2: 10000,
        weight_3: null,
      },
    ]);
    await expect(
      rollOne(buildPacks({ listPackOdds }), 'test-pack'),
    ).resolves.toMatchObject({ handle: 'pikachu' });
    await expect(
      rollOne(buildPacks({ listPackOdds }), 'test-pack', 2),
    ).resolves.toMatchObject({ handle: 'charizard' });
  });
});
