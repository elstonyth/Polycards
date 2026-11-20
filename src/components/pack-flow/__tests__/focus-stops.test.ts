import { describe, expect, it } from 'vitest';

import { blockOf, topHitsOf } from '../focus-stops-data';
import type { PackTiers } from '@/lib/pack-tiers';

const card = (n: number, rarity: string, priceMyr: number | null) => ({
  handle: `c${n}`,
  name: `Card ${n}`,
  image: `/c${n}.png`,
  slabImage: null,
  rarity,
  priceMyr,
  pokemonDex: null,
  spriteImage: null,
});

const tiers = (cards: ReturnType<typeof card>[][]) =>
  ({
    tiers: cards.map((c, i) => ({
      rarity: ['Immortal', 'Legendary', 'Mythical'][i],
      chance: null,
      count: c.length,
      range: null,
      cards: c,
    })),
    ev: null,
    range: null,
    pack: { priceMyr: 40, buybackPercent: 90, inStock: true },
  }) as unknown as PackTiers;

describe('Top Hits: one row, most valuable first', () => {
  it('flattens the top tiers and sorts by value, nulls last, stable', () => {
    const t = tiers([
      [card(1, 'Immortal', 100), card(2, 'Immortal', null)],
      [card(3, 'Legendary', 300), card(4, 'Legendary', 100)],
      [card(5, 'Mythical', 50)],
    ]);
    expect(topHitsOf({ tiers: t }, false).map((c) => c.handle)).toEqual([
      'c3',
      'c1',
      'c4',
      'c5',
      'c2',
    ]);
  });

  it('no tier view yet: an empty row', () => {
    expect(topHitsOf({ tiers: null }, false)).toEqual([]);
  });
});

describe('the block shown', () => {
  it('switches 20% into a move, both ways', () => {
    expect(blockOf(0.19, 6)).toBe(0);
    expect(blockOf(0.2, 6)).toBe(1);
    expect(blockOf(2.19, 6)).toBe(2);
    expect(blockOf(2.2, 6)).toBe(3);
    expect(blockOf(6, 6)).toBe(6);
  });
});
