import { describe, expect, it } from 'vitest';
import { ticketCard, type ResolvedPack } from '@/lib/packs-data';
import { BUYBACK_RULE } from '@/components/pack-3d/pack-back-details';
import { backFor, backKey, canTurn, shapeOf, withLive } from '../flow-back';
import { flowSeed, flowSeedFromHighlights } from '../flow-seed';
import { stopIndexAt, stopsFrom, beatOf, STOP_ANCHOR } from '../flow-stops';
import type { PackPageData } from '@/lib/data/pack-page';

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

describe('canTurn', () => {
  it('a capsule never turns, even with odds (checked first)', () => {
    // A capsule-shaped pack handed a printable back still stays on its front.
    expect(canTurn({ shape: 'capsule' }, backFor(GOLD, ODDS))).toBe(false);
  });

  it('a card pack turns only with a printable back', () => {
    expect(canTurn({ shape: 'sleeve' }, backFor(GOLD, ODDS))).toBe(true);
    expect(canTurn({ shape: 'sleeve' }, backFor(GOLD, null))).toBe(false);
    expect(canTurn({ shape: 'sleeve' }, null)).toBe(false);
  });

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

describe('flowSeed (pack page) and flowSeedFromHighlights (homepage)', () => {
  const data: PackPageData = {
    pack: GOLD,
    siblings: [GOLD],
    categoryTabs: [],
    detail: {
      topHits: [],
      pool: [
        {
          handle: 'a',
          name: 'A',
          image: '/a.png',
          slabImage: null,
          rarity: 'Immortal',
          priceMyr: 900,
          pokemonDex: null,
          spriteImage: null,
        },
      ],
      publishedOdds: ODDS,
    },
    recentPulls: { pulls: [], drought: {} },
    freePackMissing: [],
  };

  it('the pack page seed carries tiers, pulls, the odds and the back', () => {
    const seed = flowSeed(data);
    expect(seed.shape).toBe('sleeve');
    expect(seed.tiers?.tiers[0]).toMatchObject({
      rarity: 'Immortal',
      chance: 0.2,
    });
    expect(seed.recentPulls).toEqual({ pulls: [], drought: {} });
    expect(seed.pullOdds).toEqual(ODDS);
    expect(seed.back?.odds?.[0]).toEqual({ label: 'Immortal', chance: '0.2%' });
    // Owner rule: nothing the browser receives says "published".
    expect(JSON.stringify(seed)).not.toMatch(/publish/i);
  });

  it('no odds entered: no odds, no back, even with a pool', () => {
    const seed = flowSeed({
      ...data,
      detail: { ...data.detail!, publishedOdds: null },
    });
    expect(seed.pullOdds).toBeNull();
    expect(seed.back).toBeNull();
    expect(seed.tiers?.tiers.every((t) => t.chance === null)).toBe(true);
  });

  it('the homepage seed: the highlights odds, no tiers or pulls yet', () => {
    const seed = flowSeedFromHighlights(GOLD, { pullOdds: ODDS });
    expect(seed).toMatchObject({
      tiers: null,
      recentPulls: null,
      pullOdds: ODDS,
    });
    expect(seed.back).not.toBeNull();
    expect(flowSeedFromHighlights(GOLD, null).back).toBeNull();
    const capsule = flowSeedFromHighlights(CAPSULE, { pullOdds: ODDS });
    expect(capsule.shape).toBe('capsule');
    expect(capsule.back).toBeNull();
  });

  it('a capsule page seed: ticket tiers, no back', () => {
    const seed = flowSeed({
      ...data,
      pack: CAPSULE,
      detail: {
        topHits: [],
        pool: [ticketCard(300, 'Immortal')],
        publishedOdds: { tiers: { Immortal: 100 } },
      },
    });
    expect(seed.tiers?.tiers[0]?.cards?.[0]?.tickets).toBe(300);
    expect(seed.back).toBeNull();
  });
});

describe('flow stops', () => {
  it('the back at the wrapper top, each later stop where its top reaches 0.42 of the panel', () => {
    const stops = stopsFrom(
      100,
      [
        { kind: 'tier', top: 1000 },
        { kind: 'tier', top: 1400 },
        { kind: 'odds', top: 1900 },
      ],
      64,
      700,
    );
    expect(stops).toEqual([
      { y: 36, kind: 'back' },
      { y: 1000 - 64 - STOP_ANCHOR * 700, kind: 'tier' },
      { y: 1400 - 64 - STOP_ANCHOR * 700, kind: 'tier' },
      { y: 1900 - 64 - STOP_ANCHOR * 700, kind: 'odds' },
    ]);
  });

  it('never decreasing, never negative', () => {
    const stops = stopsFrom(
      0,
      [
        { kind: 'tier', top: 10 },
        { kind: 'odds', top: 5 },
      ],
      64,
      700,
    );
    expect(stops.map((s) => s.y)).toEqual([0, 0, 0]);
  });

  it('the rounded stop: halfway counts as the next', () => {
    const stops = [
      { y: 0, kind: 'back' as const },
      { y: 400, kind: 'tier' as const },
      { y: 800, kind: 'tier' as const },
      { y: 1200, kind: 'odds' as const },
    ];
    expect(stopIndexAt(stops, 0)).toBe(0);
    expect(stopIndexAt(stops, 199)).toBe(0);
    expect(stopIndexAt(stops, 200)).toBe(1);
    expect(stopIndexAt(stops, 1100)).toBe(3);
    expect(stopIndexAt(stops, 5000)).toBe(3);
    expect([0, 1, 2, 3].map((i) => beatOf(stops, i))).toEqual([
      null,
      0,
      1,
      null,
    ]);
  });
});
