import { describe, it, expect } from 'vitest';
import { poolValueRange, tierValueRanges } from '../packs-format';

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
});
