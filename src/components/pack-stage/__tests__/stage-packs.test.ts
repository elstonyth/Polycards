import { describe, expect, it } from 'vitest';
import type { Pack, PackCard, PackCategory } from '@/lib/packs-data';
import {
  STAGE_ORDER,
  orderStagePacks,
  toStageCategories,
  toStagePack,
} from '../stage-packs';
import { STAGE_START_INDEX, stageStartIndex } from '../StageTrack';

const pack = (over: Partial<Pack> & Pick<Pack, 'id'>): Pack => ({
  name: over.id,
  priceMyr: 10,
  image: `/images/polycards/${over.id}.webp`,
  ...over,
});

const chase = (priceMyr: number | null): PackCard => ({
  handle: 'charizard-1',
  name: 'Charizard',
  image: '/x.webp',
  slabImage: null,
  rarity: 'Immortal',
  priceMyr,
  pokemonDex: null,
  spriteImage: null,
});

const category = (id: string, packs: Pack[]): PackCategory => ({
  id,
  tab: id,
  heading: id,
  icon: '/pack-index-icons/pokemon.webp',
  packs,
});

describe('toStagePack', () => {
  it('labels the price in whole ringgit and links to the pack page opened on one', () => {
    const p = toStagePack(pack({ id: 'gold-pack', priceMyr: 49.5 }), null);
    expect(p.priceLabel).toBe('RM 50');
    expect(p.priceMyr).toBe(49.5);
    expect(p.href).toBe('/slots/gold-pack?count=1');
  });

  it('encodes an operator-made slug in the href', () => {
    expect(toStagePack(pack({ id: 'a b?c' }), null).href).toBe(
      '/slots/a%20b%3Fc?count=1',
    );
  });

  it('is sold out only when the backend says so', () => {
    expect(toStagePack(pack({ id: 'a', inStock: false }), null).soldOut).toBe(
      true,
    );
    expect(toStagePack(pack({ id: 'a' }), null).soldOut).toBe(false);
  });

  it('carries the top chase as RM with sen, and none when unpriced', () => {
    expect(toStagePack(pack({ id: 'a' }), chase(21350)).chaseLabel).toBe(
      'RM 21,350.00',
    );
    expect(toStagePack(pack({ id: 'a' }), chase(null)).chaseLabel).toBeNull();
    expect(toStagePack(pack({ id: 'a' }), null).chaseLabel).toBeNull();
  });

  it('takes the 3D set from the catalogue lookup for card packs', () => {
    const art = { front: '/f', frontHalf: '/fh', width: 900, height: 1666 };
    const p = toStagePack(pack({ id: 'gold-pack' }), null, (id) =>
      id === 'gold-pack' ? art : null,
    );
    expect(p.art3d).toEqual(art);
  });

  it('never gives a capsule (ticket pack) a 3D set, a chase or a boost', () => {
    const p = toStagePack(
      pack({ id: 'gold-pack', prizeType: 'tickets', boost: undefined }),
      chase(500),
      () => ({ front: '/f', frontHalf: '/fh', width: 1, height: 1 }),
    );
    expect(p.ticket).toBe(true);
    expect(p.art3d).toBeNull();
    expect(p.chaseLabel).toBeNull();
    expect(p.boost).toBe(false);
  });

  it('defaults the buyback to the flat rate', () => {
    expect(toStagePack(pack({ id: 'a' }), null).buybackPercent).toBe(90);
    expect(
      toStagePack(pack({ id: 'a', buybackPercent: 95, boost: true }), null),
    ).toMatchObject({ buybackPercent: 95, boost: true });
  });

  it('reads the real catalogue: bundled packs have versioned half fronts, others none', () => {
    const real = toStagePack(pack({ id: '151' }), null);
    expect(real.art3d?.frontHalf).toMatch(
      /^\/pack-3d\/151\/front-half\.webp\?v=[0-9a-f]{8}$/,
    );
    expect(real.art3d?.width).toBeGreaterThan(0);
    // Operator-entered ids are looked up as own keys only.
    expect(toStagePack(pack({ id: 'constructor' }), null).art3d).toBeNull();
    expect(toStagePack(pack({ id: 'no-such-pack' }), null).art3d).toBeNull();
  });
});

describe('orderStagePacks: by price, cheapest first', () => {
  it('is the default order', () => {
    expect(STAGE_ORDER).toBe('price');
  });

  it('sorts every pack by price across pack types (no type shelves)', () => {
    const order = orderStagePacks([
      pack({ id: 'u-cheap', priceMyr: 1 }),
      pack({ id: 'special', priceMyr: 5, packType: 'special' }),
      pack({ id: 'classic-dear', priceMyr: 500, packType: 'classic' }),
      pack({ id: 'classic-cheap', priceMyr: 10, packType: 'classic' }),
      pack({ id: 'original', priceMyr: 40, packType: 'original' }),
    ]).map((p) => p.id);
    expect(order).toEqual([
      'u-cheap',
      'special',
      'classic-cheap',
      'original',
      'classic-dear',
    ]);
  });

  it('keeps catalogue order on a price tie and never drops a pack', () => {
    const packs = [
      pack({ id: 'b', priceMyr: 10 }),
      pack({ id: 'a', priceMyr: 10 }),
      pack({ id: 'c', priceMyr: 3 }),
    ];
    expect(orderStagePacks(packs).map((p) => p.id)).toEqual(['c', 'b', 'a']);
  });

  it("puts today's Pokémon line-up in the agreed order", () => {
    const live = [
      ['bronze-pack', 300],
      ['silver-pack', 600],
      ['gold-pack', 1200],
      ['platinum-pack', 2500],
      ['diamond-pack', 5000],
      ['cr', 15],
      ['delta-reign', 18],
      ['151', 40],
      ['30th-celebration', 45],
      ['ah', 50],
      ['poncho-pack', 22000],
    ] as const;
    const order = orderStagePacks(
      live.map(([id, priceMyr]) => pack({ id, priceMyr })),
    ).map((p) => p.id);
    expect(order).toEqual([
      'cr',
      'delta-reign',
      '151',
      '30th-celebration',
      'ah',
      'bronze-pack',
      'silver-pack',
      'gold-pack',
      'platinum-pack',
      'diamond-pack',
      'poncho-pack',
    ]);
    expect(order[stageStartIndex(order.map(() => ({ soldOut: false })))]).toBe(
      '151',
    );
  });
});

describe('stageStartIndex: the third pack, nearest in stock', () => {
  const row = (...sold: boolean[]) => sold.map((soldOut) => ({ soldOut }));

  it('starts on the third pack', () => {
    expect(STAGE_START_INDEX).toBe(2);
    expect(stageStartIndex(row(false, false, false, false, false))).toBe(2);
  });

  it('clamps to a short list', () => {
    expect(stageStartIndex(row(false, false))).toBe(1);
    expect(stageStartIndex(row(false))).toBe(0);
    expect(stageStartIndex([])).toBe(0);
  });

  it('moves to the nearest pack in stock, the earlier one on a tie', () => {
    expect(stageStartIndex(row(false, false, true, false, false))).toBe(1);
    expect(stageStartIndex(row(true, true, true, false, false))).toBe(3);
    expect(stageStartIndex(row(false, true, true, true, true))).toBe(0);
    expect(stageStartIndex(row(true, false, true))).toBe(1);
  });

  it('keeps the clamped index when nothing is in stock', () => {
    expect(stageStartIndex(row(true, true, true, true))).toBe(2);
  });
});

describe('toStageCategories', () => {
  it('keeps every category with packs, in catalogue order, and drops empty ones', () => {
    const out = toStageCategories(
      [
        category('pokemon', [
          pack({ id: 'gold-pack', priceMyr: 50 }),
          pack({ id: 'bronze-pack', priceMyr: 5, inStock: false }),
        ]),
        category('one-piece', []),
        category('poly', [pack({ id: 'cap', prizeType: 'tickets' })]),
      ],
      new Map([['gold-pack', chase(100)]]),
      () => null,
    );
    expect(out.map((c) => c.id)).toEqual(['pokemon', 'poly']);
    expect(out[0]?.packs.map((p) => [p.id, p.soldOut, p.chaseLabel])).toEqual([
      ['bronze-pack', true, null],
      ['gold-pack', false, 'RM 100.00'],
    ]);
    expect(out[1]?.packs[0]?.ticket).toBe(true);
  });

  it('is empty when the catalogue is (a backend outage)', () => {
    expect(
      toStageCategories([category('pokemon', [])], new Map(), () => null),
    ).toEqual([]);
  });
});
