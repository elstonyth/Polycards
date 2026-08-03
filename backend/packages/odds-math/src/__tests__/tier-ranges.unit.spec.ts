import {
  rarityForValue,
  tierRangeStatus,
  type TierRangeMap,
} from '../index';

// RM display prices, ascending with rarity. Common has a MINIMUM on purpose —
// the operator's ask: a card cheaper than the cheapest tier matches nothing.
const RANGES: TierRangeMap = {
  Common: { min: 100, max: 500 },
  Uncommon: { min: 500, max: 2000 },
  Rare: { min: 2000, max: 10000 },
  Legendary: { min: 10000, max: null },
};

describe('rarityForValue', () => {
  it('assigns each tier by [min, max) — inclusive min, exclusive max', () => {
    expect(rarityForValue(100, RANGES)).toBe('Common');
    expect(rarityForValue(499.99, RANGES)).toBe('Common');
    expect(rarityForValue(500, RANGES)).toBe('Uncommon');
    expect(rarityForValue(2000, RANGES)).toBe('Rare');
  });

  it('treats a null max as open-ended', () => {
    expect(rarityForValue(1_000_000, RANGES)).toBe('Legendary');
  });

  it('returns null below the lowest configured minimum', () => {
    expect(rarityForValue(50, RANGES)).toBeNull();
  });

  it('returns null inside a gap between tiers', () => {
    const gappy: TierRangeMap = {
      Common: { min: 0, max: 100 },
      Rare: { min: 1000, max: null },
    };
    expect(rarityForValue(500, gappy)).toBeNull();
  });

  it('picks the RAREST tier when ranges overlap (RARITIES order)', () => {
    const overlapping: TierRangeMap = {
      Common: { min: 0, max: 1000 },
      Rare: { min: 500, max: 2000 },
    };
    expect(rarityForValue(750, overlapping)).toBe('Rare');
  });

  it('skips tiers with no usable range', () => {
    const partial: TierRangeMap = {
      Rare: { min: null, max: null },
      Common: { min: 0, max: 100 },
    };
    expect(rarityForValue(50, partial)).toBe('Common');
  });

  it('is inert on an empty config or unusable value', () => {
    expect(rarityForValue(500, {})).toBeNull();
    expect(rarityForValue(Number.NaN, RANGES)).toBeNull();
    expect(rarityForValue(-1, RANGES)).toBeNull();
  });

  it('a null min is open-ended downward', () => {
    const openLow: TierRangeMap = { Common: { min: null, max: 100 } };
    expect(rarityForValue(0, openLow)).toBe('Common');
  });
});

describe('tierRangeStatus', () => {
  it("reports 'in' inside the assigned tier's range", () => {
    expect(tierRangeStatus(300, 'Common', RANGES)).toBe('in');
    expect(tierRangeStatus(100, 'Common', RANGES)).toBe('in');
  });

  it("reports 'below' under the min and 'above' at/over the max", () => {
    expect(tierRangeStatus(99, 'Common', RANGES)).toBe('below');
    expect(tierRangeStatus(500, 'Common', RANGES)).toBe('above');
    expect(tierRangeStatus(9000, 'Uncommon', RANGES)).toBe('above');
  });

  it('open bounds never trip their side', () => {
    expect(tierRangeStatus(50_000_000, 'Legendary', RANGES)).toBe('in');
    const openLow: TierRangeMap = { Common: { min: null, max: 100 } };
    expect(tierRangeStatus(0, 'Common', openLow)).toBe('in');
  });

  it("reports 'unset' for unconfigured tiers, unknown rarities and bad values", () => {
    expect(tierRangeStatus(300, 'Mythical', RANGES)).toBe('unset');
    expect(tierRangeStatus(300, 'NotATier', RANGES)).toBe('unset');
    expect(tierRangeStatus(300, 'Rare', { Rare: { min: null, max: null } })).toBe(
      'unset',
    );
    expect(tierRangeStatus(Number.NaN, 'Common', RANGES)).toBe('unset');
    expect(tierRangeStatus(300, 'Common', {})).toBe('unset');
  });
});
