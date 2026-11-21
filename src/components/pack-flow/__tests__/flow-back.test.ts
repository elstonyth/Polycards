import { describe, expect, it } from 'vitest';
import type { ResolvedPack } from '@/lib/packs-data';
import { BUYBACK_RULE } from '@/components/pack-3d/pack-back-details';
import { backFor, backKey, shapeOf, withLive } from '../flow-back';
import { flowSeedFromHighlights } from '../flow-seed';

const GOLD: ResolvedPack = {
  id: 'gold-pack',
  name: 'Gold Pack',
  priceMyr: 1200,
  image: '/g.webp',
  categoryId: 'pokemon',
  categoryName: 'Pokémon',
  icon: '/p.webp',
  buybackPercent: 90,
};
const CAPSULE: ResolvedPack = {
  ...GOLD,
  id: 'gold-capsule',
  name: 'Gold Capsule',
  categoryId: 'poly',
  prizeType: 'tickets',
};
const ODDS = { tiers: { Immortal: 0.2, Legendary: 2.4, Common: 97.4 } };

describe('backFor', () => {
  it("prints the page's price, odds rows and buyback", () => {
    const back = backFor(GOLD, ODDS)!;
    expect(back.price).toBe('RM 1,200.00');
    expect(back.odds).toEqual([
      { label: 'Immortal', chance: '0.2%' },
      { label: 'Legendary', chance: '2.4%' },
      { label: 'Common', chance: '97.4%' },
    ]);
    expect(back.buyback).toEqual({
      headline: '90% instant buyback',
      rule: BUYBACK_RULE,
    });
  });

  it('no pull odds: never a back (no empty odds box)', () => {
    expect(backFor(GOLD, null)).toBeNull();
    expect(backFor(GOLD, undefined)).toBeNull();
    expect(backFor(GOLD, { tiers: {} })).toBeNull();
  });

  it('a capsule never has a back, odds or not', () => {
    expect(backFor(CAPSULE, ODDS)).toBeNull();
  });

  it('the live figures reprint it (Lossless Mode lifts the buyback)', () => {
    const live = { priceMyr: 1300, buybackPercent: 100, inStock: true };
    const back = backFor(GOLD, ODDS, live)!;
    expect(back.price).toBe('RM 1,300.00');
    expect(back.buyback?.headline).toBe('100% instant buyback');
    expect(backKey(back)).not.toBe(backKey(backFor(GOLD, ODDS)));
    expect(backKey(backFor(GOLD, ODDS))).toBe(backKey(backFor(GOLD, ODDS)));
    expect(backKey(null)).toBe('none');
  });
});

describe('shapeOf', () => {
  it('shapes come from the prize type', () => {
    expect(shapeOf(GOLD)).toBe('sleeve');
    expect(shapeOf(CAPSULE)).toBe('capsule');
  });
});

describe('withLive', () => {
  it('applies price, buyback and stock; a capsule keeps its own buyback', () => {
    expect(
      withLive(GOLD, { priceMyr: 1, buybackPercent: 100, inStock: false }),
    ).toMatchObject({ priceMyr: 1, buybackPercent: 100, inStock: false });
    expect(
      withLive(CAPSULE, { priceMyr: 40, buybackPercent: null, inStock: true }),
    ).toMatchObject({ buybackPercent: 90, inStock: undefined });
    expect(withLive(GOLD, null)).toBe(GOLD);
  });
});

describe('flowSeedFromHighlights (homepage)', () => {
  it('the homepage seed: the highlights odds, no tiers or pulls yet', () => {
    const seed = flowSeedFromHighlights(GOLD, { pullOdds: ODDS });
    expect(seed).toMatchObject({
      tiers: null,
      recentPulls: null,
      pullOdds: ODDS,
    });
    expect(seed.back).not.toBeNull();
    // Owner rule: nothing the browser receives says "published".
    expect(JSON.stringify(seed)).not.toMatch(/publish/i);
    expect(flowSeedFromHighlights(GOLD, null).back).toBeNull();
    const capsule = flowSeedFromHighlights(CAPSULE, { pullOdds: ODDS });
    expect(capsule.shape).toBe('capsule');
    expect(capsule.back).toBeNull();
  });
});
