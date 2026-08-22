import { describe, it, expect } from 'vitest';
import {
  poolValueRange,
  poolExpectedValue,
  tierValueRanges,
} from '../packs-format';

describe('poolValueRange', () => {
  it('returns the min and max of priced cards, formatted', () => {
    const pool = [
      { value: 'RM 9,869.90' },
      { value: 'RM 4,861.30' },
      { value: 'RM 45.20' },
    ];
    expect(poolValueRange(pool)).toEqual({
      min: 'RM 45.20',
      max: 'RM 9,869.90',
    });
  });

  it("ignores unpriced '—' cards", () => {
    const pool = [{ value: '—' }, { value: 'RM 100.00' }, { value: '—' }];
    expect(poolValueRange(pool)).toEqual({
      min: 'RM 100.00',
      max: 'RM 100.00',
    });
  });

  it("returns null when nothing is priced (all '—' or empty)", () => {
    expect(poolValueRange([{ value: '—' }])).toBeNull();
    expect(poolValueRange([])).toBeNull();
  });

  // Documented conflation: '—' parses to 0, so a genuine RM 0.00 is
  // indistinguishable from unpriced and is dropped the same way.
  it('drops zero-priced cards', () => {
    expect(poolValueRange([{ value: 'RM 0.00' }])).toBeNull();
    expect(
      poolValueRange([{ value: 'RM 0.00' }, { value: 'RM 12.50' }]),
    ).toEqual({ min: 'RM 12.50', max: 'RM 12.50' });
  });

  it('collapses a single priced card to min === max', () => {
    expect(poolValueRange([{ value: 'RM 1,200.00' }])).toEqual({
      min: 'RM 1,200.00',
      max: 'RM 1,200.00',
    });
  });
});

describe('tierValueRanges', () => {
  const pool = [
    { rarity: 'Immortal', value: 'RM 22,377.23' },
    { rarity: 'Immortal', value: 'RM 9,869.90' },
    { rarity: 'Rare', value: 'RM 1,676.90' },
    { rarity: 'Common', value: '—' },
  ];

  it('gives each tier its own min–max, independent of the pack-wide range', () => {
    expect(tierValueRanges(pool)).toEqual({
      Immortal: { min: 'RM 9,869.90', max: 'RM 22,377.23' },
      Rare: { min: 'RM 1,676.90', max: 'RM 1,676.90' },
    });
  });

  it('omits tiers with nothing priced, and unknown tier strings', () => {
    const ranges = tierValueRanges([
      ...pool,
      { rarity: 'Epic', value: 'RM 500.00' }, // pre-rename tier, no longer valid
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

  // A backend without marketPriceMyr prices every card as '—'. The odds panel
  // must then render tier rows with no range line rather than blow up, so the
  // empty and fully-unpriced pools have to come back as a plain empty object.
  it('returns an empty object for an empty pool', () => {
    expect(tierValueRanges([])).toEqual({});
  });

  it('returns an empty object when every card is unpriced', () => {
    expect(
      tierValueRanges([
        { rarity: 'Immortal', value: '—' },
        { rarity: 'Rare', value: '—' },
        { rarity: 'Common', value: '—' },
      ]),
    ).toEqual({});
  });

  it('agrees with poolValueRange that an unpriced pool has no range at all', () => {
    const unpriced = [{ rarity: 'Rare', value: '—' }];
    expect(poolValueRange(unpriced)).toBeNull();
    expect(tierValueRanges(unpriced)).toEqual({});
  });
});

describe('poolExpectedValue', () => {
  it('folds tier averages against the published percentages', () => {
    // Rare avg 100, Common avg 50 → 0.2×100 + 0.8×50 = 60.
    const pool = [
      { rarity: 'Rare', value: 'RM 150.00' },
      { rarity: 'Rare', value: 'RM 50.00' },
      { rarity: 'Common', value: 'RM 50.00' },
    ];
    expect(poolExpectedValue(pool, { Rare: 20, Common: 80 })).toBe('RM 60.00');
  });

  it("skips unpriced '—' cards in the tier average, like poolValueRange", () => {
    // tiers must sum to ~100 post-guard (plan 119); Rare:100 is the only
    // published tier so the average itself still proves the skip: if the
    // unpriced card were counted, avg would be 50, not 100.
    const pool = [
      { rarity: 'Rare', value: 'RM 100.00' },
      { rarity: 'Rare', value: '—' },
    ];
    expect(poolExpectedValue(pool, { Rare: 100 })).toBe('RM 100.00');
  });

  it('returns null when no published tier has a priced card', () => {
    const pool = [{ rarity: 'Common', value: 'RM 10.00' }];
    expect(poolExpectedValue(pool, { Immortal: 100 })).toBeNull();
    expect(poolExpectedValue(pool, {})).toBeNull();
    expect(
      poolExpectedValue([{ rarity: 'Common', value: '—' }], { Common: 100 }),
    ).toBeNull();
  });

  // Plan 119: the row must only render when the published odds are an
  // arithmetically coherent promise — Σ≈100, with every published tier
  // actually contributing priced cards. Otherwise the caller's "Card value
  // range" fallback is the honest display.
  it('case 1 — happy path: tiers sum to exactly 100, pins the pre-plan value', () => {
    // Rare avg 100, Common avg 50 → 0.2×100 + 0.8×50 = 60 — same fixture and
    // expected string as the original (pre-guard) 'folds tier averages'
    // test above, proving the guard changes nothing for a well-formed pack.
    const pool = [
      { rarity: 'Rare', value: 'RM 150.00' },
      { rarity: 'Rare', value: 'RM 50.00' },
      { rarity: 'Common', value: 'RM 50.00' },
    ];
    expect(poolExpectedValue(pool, { Rare: 20, Common: 80 })).toBe('RM 60.00');
  });

  it('case 2 — rounding tolerance: 33.3 + 33.3 + 33.4 sums within 0.5 of 100', () => {
    const pool = [
      { rarity: 'Immortal', value: 'RM 300.00' },
      { rarity: 'Legendary', value: 'RM 300.00' },
      { rarity: 'Mythical', value: 'RM 300.00' },
    ];
    expect(
      poolExpectedValue(pool, {
        Immortal: 33.3,
        Legendary: 33.3,
        Mythical: 33.4,
      }),
    ).toBe('RM 300.00');
  });

  it('case 3 — sum under 100 (one tier at 40, nothing else) is suppressed', () => {
    const pool = [{ rarity: 'Rare', value: 'RM 100.00' }];
    expect(poolExpectedValue(pool, { Rare: 40 })).toBeNull();
  });

  it('case 4 — sum over 100 (60 + 60) is suppressed', () => {
    const pool = [
      { rarity: 'Rare', value: 'RM 100.00' },
      { rarity: 'Common', value: 'RM 50.00' },
    ];
    expect(poolExpectedValue(pool, { Rare: 60, Common: 60 })).toBeNull();
  });

  it('case 5 — a published tier with no priced card drops probability mass, suppressed', () => {
    // Immortal is published at 50% but has zero priced cards in the pool —
    // even though the raw percentages sum to 100, half the promised mass
    // would silently vanish from the fold.
    const pool = [{ rarity: 'Rare', value: 'RM 100.00' }];
    expect(poolExpectedValue(pool, { Immortal: 50, Rare: 50 })).toBeNull();
  });

  it('case 6 — a published tier at pct 0 with no priced cards cannot disqualify', () => {
    const pool = [{ rarity: 'Rare', value: 'RM 100.00' }];
    expect(poolExpectedValue(pool, { Immortal: 0, Rare: 100 })).toBe(
      'RM 100.00',
    );
  });
});
