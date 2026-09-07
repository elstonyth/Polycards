import { describe, it, expect } from 'vitest';
import {
  poolValueRange,
  poolExpectedValue,
  tierValueRanges,
} from '../packs-format';

// Pool money maths over NUMBERS: `priceMyr` in (null = unpriced), numbers out;
// the odds panel formats with rm() at the render edge.

describe('poolValueRange', () => {
  it('returns the min and max of priced cards', () => {
    const pool = [
      { priceMyr: 9869.9 },
      { priceMyr: 4861.3 },
      { priceMyr: 45.2 },
    ];
    expect(poolValueRange(pool)).toEqual({ min: 45.2, max: 9869.9 });
  });

  it('ignores unpriced (null) cards', () => {
    const pool = [{ priceMyr: null }, { priceMyr: 100 }, { priceMyr: null }];
    expect(poolValueRange(pool)).toEqual({ min: 100, max: 100 });
  });

  it('returns null when nothing is priced (all null or empty)', () => {
    expect(poolValueRange([{ priceMyr: null }])).toBeNull();
    expect(poolValueRange([])).toBeNull();
  });

  // Deliberate: "RM 0.00 – RM 9,869.90" reads as a broken range, so a genuine
  // RM 0.00 is dropped like an unpriced card.
  it('drops zero-priced cards', () => {
    expect(poolValueRange([{ priceMyr: 0 }])).toBeNull();
    expect(poolValueRange([{ priceMyr: 0 }, { priceMyr: 12.5 }])).toEqual({
      min: 12.5,
      max: 12.5,
    });
  });

  it('collapses a single priced card to min === max', () => {
    expect(poolValueRange([{ priceMyr: 1200 }])).toEqual({
      min: 1200,
      max: 1200,
    });
  });
});

describe('tierValueRanges', () => {
  const pool = [
    { rarity: 'Immortal', priceMyr: 22377.23 },
    { rarity: 'Immortal', priceMyr: 9869.9 },
    { rarity: 'Rare', priceMyr: 1676.9 },
    { rarity: 'Common', priceMyr: null },
  ];

  it('gives each tier its own min–max, independent of the pack-wide range', () => {
    expect(tierValueRanges(pool)).toEqual({
      Immortal: { min: 9869.9, max: 22377.23 },
      Rare: { min: 1676.9, max: 1676.9 },
    });
  });

  it('omits tiers with nothing priced, and unknown tier strings', () => {
    const ranges = tierValueRanges([
      ...pool,
      { rarity: 'Epic', priceMyr: 500 }, // pre-rename tier, no longer valid
    ]);
    // Common is present in the pool but unpriced; Epic is not a tier at all.
    expect(ranges).not.toHaveProperty('Common');
    expect(ranges).not.toHaveProperty('Epic');
    expect(ranges).not.toHaveProperty('Legendary');
  });

  it('never disagrees with poolValueRange on the overall span', () => {
    const ranges = tierValueRanges(pool);
    const mins = Object.values(ranges).map((r) => r.min);
    const maxes = Object.values(ranges).map((r) => r.max);
    const overall = poolValueRange(pool);
    expect(mins).toContain(overall?.min);
    expect(maxes).toContain(overall?.max);
  });

  // A backend without marketPriceMyr leaves every card unpriced. The odds
  // panel must then render tier rows with no range line rather than blow up,
  // so the empty and fully-unpriced pools have to come back as a plain empty
  // object.
  it('returns an empty object for an empty pool', () => {
    expect(tierValueRanges([])).toEqual({});
  });

  it('returns an empty object when every card is unpriced', () => {
    expect(
      tierValueRanges([
        { rarity: 'Immortal', priceMyr: null },
        { rarity: 'Rare', priceMyr: null },
        { rarity: 'Common', priceMyr: null },
      ]),
    ).toEqual({});
  });

  it('agrees with poolValueRange that an unpriced pool has no range at all', () => {
    const unpriced = [{ rarity: 'Rare', priceMyr: null }];
    expect(poolValueRange(unpriced)).toBeNull();
    expect(tierValueRanges(unpriced)).toEqual({});
  });
});

describe('poolExpectedValue', () => {
  it('folds tier averages against the published percentages', () => {
    // Rare avg 100, Common avg 50 → 0.2×100 + 0.8×50 = 60.
    const pool = [
      { rarity: 'Rare', priceMyr: 150 },
      { rarity: 'Rare', priceMyr: 50 },
      { rarity: 'Common', priceMyr: 50 },
    ];
    expect(poolExpectedValue(pool, { Rare: 20, Common: 80 })).toBe(60);
  });

  it('skips unpriced cards in the tier average, like poolValueRange', () => {
    // tiers must sum to ~100 post-guard (plan 119); Rare:100 is the only
    // published tier so the average itself still proves the skip: if the
    // unpriced card were counted, avg would be 50, not 100.
    const pool = [
      { rarity: 'Rare', priceMyr: 100 },
      { rarity: 'Rare', priceMyr: null },
    ];
    expect(poolExpectedValue(pool, { Rare: 100 })).toBe(100);
  });

  it('returns null when no published tier has a priced card', () => {
    const pool = [{ rarity: 'Common', priceMyr: 10 }];
    expect(poolExpectedValue(pool, { Immortal: 100 })).toBeNull();
    expect(poolExpectedValue(pool, {})).toBeNull();
    expect(
      poolExpectedValue([{ rarity: 'Common', priceMyr: null }], {
        Common: 100,
      }),
    ).toBeNull();
  });

  it('rounds to cents', () => {
    // 1/3 of 10 → 3.333… → 3.33 at the fold, so rm() has nothing to re-round.
    const pool = [
      { rarity: 'Rare', priceMyr: 10 },
      { rarity: 'Rare', priceMyr: 0.01 },
      { rarity: 'Rare', priceMyr: 0.01 },
    ];
    expect(poolExpectedValue(pool, { Rare: 100 })).toBe(3.34);
  });

  // Plan 119: the row must only render when the published odds are an
  // arithmetically coherent promise — Σ≈100, with every published tier
  // actually contributing priced cards. Otherwise the caller's "Card value
  // range" fallback is the honest display.
  it('case 1 — happy path: tiers sum to exactly 100, pins the pre-plan value', () => {
    // Rare avg 100, Common avg 50 → 0.2×100 + 0.8×50 = 60 — same fixture and
    // expected value as the original (pre-guard) 'folds tier averages' test
    // above, proving the guard changes nothing for a well-formed pack.
    const pool = [
      { rarity: 'Rare', priceMyr: 150 },
      { rarity: 'Rare', priceMyr: 50 },
      { rarity: 'Common', priceMyr: 50 },
    ];
    expect(poolExpectedValue(pool, { Rare: 20, Common: 80 })).toBe(60);
  });

  it('case 2 — rounding tolerance: 33.3 + 33.3 + 33.4 sums within 0.5 of 100', () => {
    const pool = [
      { rarity: 'Immortal', priceMyr: 300 },
      { rarity: 'Legendary', priceMyr: 300 },
      { rarity: 'Mythical', priceMyr: 300 },
    ];
    expect(
      poolExpectedValue(pool, {
        Immortal: 33.3,
        Legendary: 33.3,
        Mythical: 33.4,
      }),
    ).toBe(300);
  });

  it('case 3 — sum under 100 (one tier at 40, nothing else) is suppressed', () => {
    const pool = [{ rarity: 'Rare', priceMyr: 100 }];
    expect(poolExpectedValue(pool, { Rare: 40 })).toBeNull();
  });

  it('case 4 — sum over 100 (60 + 60) is suppressed', () => {
    const pool = [
      { rarity: 'Rare', priceMyr: 100 },
      { rarity: 'Common', priceMyr: 50 },
    ];
    expect(poolExpectedValue(pool, { Rare: 60, Common: 60 })).toBeNull();
  });

  it('case 5 — a published tier with no priced card drops probability mass, suppressed', () => {
    // Immortal is published at 50% but has zero priced cards in the pool —
    // even though the raw percentages sum to 100, half the promised mass
    // would silently vanish from the fold.
    const pool = [{ rarity: 'Rare', priceMyr: 100 }];
    expect(poolExpectedValue(pool, { Immortal: 50, Rare: 50 })).toBeNull();
  });

  it('case 6 — a published tier at pct 0 with no priced cards cannot disqualify', () => {
    const pool = [{ rarity: 'Rare', priceMyr: 100 }];
    expect(poolExpectedValue(pool, { Immortal: 0, Rare: 100 })).toBe(100);
  });
});
