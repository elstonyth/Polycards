import {
  MAX_TIER_BOUND_MYR,
  validateTierRanges,
} from '../tier-settings-validate';

describe('validateTierRanges', () => {
  it('accepts a partial map with open bounds', () => {
    expect(
      validateTierRanges({
        ranges: {
          Common: { min: 100, max: 500 },
          Legendary: { min: 10000, max: null },
          Rare: { max: 10000 },
        },
      }),
    ).toEqual({
      Common: { min: 100, max: 500 },
      Legendary: { min: 10000, max: null },
      Rare: { min: null, max: 10000 },
    });
  });

  it('accepts an empty map (feature off) and a fully-null tier', () => {
    expect(validateTierRanges({ ranges: {} })).toEqual({});
    expect(
      validateTierRanges({ ranges: { Common: { min: null, max: null } } }),
    ).toEqual({ Common: { min: null, max: null } });
  });

  it('rejects a missing/non-object ranges body', () => {
    expect(() => validateTierRanges({})).toThrow(/ranges must be an object/);
    expect(() => validateTierRanges({ ranges: [] })).toThrow(
      /ranges must be an object/,
    );
  });

  it('rejects unknown rarity keys', () => {
    expect(() =>
      validateTierRanges({ ranges: { Shiny: { min: 0, max: 1 } } }),
    ).toThrow(/Unknown rarity 'Shiny'/);
  });

  it('rejects non-numeric, negative and absurd bounds', () => {
    expect(() =>
      validateTierRanges({ ranges: { Common: { min: '5', max: null } } }),
    ).toThrow(/min must be null or a number/);
    expect(() =>
      validateTierRanges({ ranges: { Common: { min: -1, max: null } } }),
    ).toThrow(/min must be null or a number/);
    expect(() =>
      validateTierRanges({
        ranges: { Common: { min: null, max: MAX_TIER_BOUND_MYR + 1 } },
      }),
    ).toThrow(/max must be null or a number/);
    expect(() =>
      validateTierRanges({
        ranges: { Common: { min: Number.NaN, max: null } },
      }),
    ).toThrow(/min must be null or a number/);
  });

  it('rejects min > max', () => {
    expect(() =>
      validateTierRanges({ ranges: { Common: { min: 500, max: 100 } } }),
    ).toThrow(/min must not exceed max/);
  });

  it('allows overlapping tiers (assignment picks the rarest match)', () => {
    expect(
      validateTierRanges({
        ranges: {
          Common: { min: 0, max: 1000 },
          Rare: { min: 500, max: 2000 },
        },
      }),
    ).toEqual({
      Common: { min: 0, max: 1000 },
      Rare: { min: 500, max: 2000 },
    });
  });
});
