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
    const pool = [
      { rarity: 'Rare', value: 'RM 100.00' },
      { rarity: 'Rare', value: '—' },
    ];
    expect(poolExpectedValue(pool, { Rare: 50 })).toBe('RM 50.00');
  });

  it('returns null when no published tier has a priced card', () => {
    const pool = [{ rarity: 'Common', value: 'RM 10.00' }];
    expect(poolExpectedValue(pool, { Immortal: 100 })).toBeNull();
    expect(poolExpectedValue(pool, {})).toBeNull();
    expect(
      poolExpectedValue([{ rarity: 'Common', value: '—' }], { Common: 100 }),
    ).toBeNull();
  });
});
