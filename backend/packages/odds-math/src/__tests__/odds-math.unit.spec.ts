import {
  computeOdds,
  RARITY_WEIGHT,
  RARITIES,
  TOTAL_BPS,
  type OddsInput,
} from '../index';

const sumWeight = (computed: { weight: number }[]) =>
  computed.reduce((s, c) => s + c.weight, 0);

const unlocked = (card_id: string, rarity = 'Common'): OddsInput => ({
  card_id,
  locked: false,
  pct: 0,
  rarity,
});
const locked = (
  card_id: string,
  pct: number,
  rarity = 'Common',
): OddsInput => ({
  card_id,
  locked: true,
  pct,
  rarity,
});

describe('computeOdds — same-rarity (even-split) invariants', () => {
  it('splits evenly across all-unlocked same-rarity cards and sums to exactly 10000 bps', () => {
    const entries = ['a', 'b', 'c', 'd'].map((id) => unlocked(id));
    const { computed, error } = computeOdds(entries);
    expect(error).toBeNull();
    expect(sumWeight(computed)).toBe(TOTAL_BPS);
    expect(computed.map((c) => c.weight)).toEqual([2500, 2500, 2500, 2500]);
  });

  it('distributes the rounding remainder so the total is still exactly 10000', () => {
    const entries = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) =>
      unlocked(id),
    );
    const { computed, error } = computeOdds(entries);
    expect(error).toBeNull();
    expect(sumWeight(computed)).toBe(TOTAL_BPS);
    const weights = computed.map((c) => c.weight).sort((x, y) => x - y);
    expect(weights).toEqual([1428, 1428, 1428, 1429, 1429, 1429, 1429]);
  });

  it('locks one card and splits the remainder evenly among the rest (advisor example)', () => {
    const entries = [
      locked('a', 40),
      unlocked('b'),
      unlocked('c'),
      unlocked('d'),
    ];
    const { computed, error } = computeOdds(entries);
    expect(error).toBeNull();
    expect(sumWeight(computed)).toBe(TOTAL_BPS);
    const byId = Object.fromEntries(computed.map((c) => [c.card_id, c.weight]));
    expect(byId.a).toBe(4000);
    expect(byId.b).toBe(2000);
    expect(byId.c).toBe(2000);
    expect(byId.d).toBe(2000);
  });

  it('supports fractional locked percentages (2 dp → bps)', () => {
    const entries = [locked('a', 12.5), unlocked('b'), unlocked('c')];
    const { computed, error } = computeOdds(entries);
    expect(error).toBeNull();
    const byId = Object.fromEntries(computed.map((c) => [c.card_id, c.weight]));
    expect(byId.a).toBe(1250);
    expect(byId.b).toBe(4375);
    expect(byId.c).toBe(4375);
    expect(sumWeight(computed)).toBe(TOTAL_BPS);
  });
});

describe('computeOdds — rarity-weighted split', () => {
  it('orders the tiers rarest-first (Immortal least likely)', () => {
    expect(RARITY_WEIGHT.Immortal).toBeLessThan(RARITY_WEIGHT.Legendary);
    expect(RARITY_WEIGHT.Legendary).toBeLessThan(RARITY_WEIGHT.Epic);
    expect(RARITY_WEIGHT.Epic).toBeLessThan(RARITY_WEIGHT.Rare);
    expect(RARITY_WEIGHT.Rare).toBeLessThan(RARITY_WEIGHT.Uncommon);
    expect(RARITY_WEIGHT.Uncommon).toBeLessThan(RARITY_WEIGHT.Common);
  });

  it('lists RARITIES rarest-first with Immortal as the apex tier', () => {
    expect(RARITIES[0]).toBe('Immortal');
    expect(RARITIES).toEqual([
      'Immortal',
      'Legendary',
      'Epic',
      'Rare',
      'Uncommon',
      'Common',
    ]);
  });

  it('splits unlocked cards proportionally to their rarity weight', () => {
    const entries = [unlocked('leg', 'Legendary'), unlocked('com', 'Common')];
    const { computed, error } = computeOdds(entries);
    expect(error).toBeNull();
    const byId = Object.fromEntries(computed.map((c) => [c.card_id, c.weight]));
    expect(byId.leg).toBe(99);
    expect(byId.com).toBe(9901);
    expect(sumWeight(computed)).toBe(TOTAL_BPS);
  });

  it('combines a locked % with a rarity-weighted remainder', () => {
    const entries = [
      locked('a', 40),
      unlocked('b', 'Legendary'),
      unlocked('c', 'Common'),
    ];
    const { computed, error } = computeOdds(entries);
    expect(error).toBeNull();
    const byId = Object.fromEntries(computed.map((c) => [c.card_id, c.weight]));
    expect(byId.a).toBe(4000);
    expect(byId.b).toBe(59);
    expect(byId.c).toBe(5941);
    expect(sumWeight(computed)).toBe(TOTAL_BPS);
  });

  it('treats an unknown rarity string as Common instead of throwing', () => {
    const entries = [unlocked('a', 'Mythic'), unlocked('b', 'Common')];
    const { computed, error } = computeOdds(entries);
    expect(error).toBeNull();
    const byId = Object.fromEntries(computed.map((c) => [c.card_id, c.weight]));
    expect(byId.a).toBe(5000);
    expect(byId.b).toBe(5000);
  });

  it('is order-independent: the same set in any order yields the same per-card weights', () => {
    const a = [
      locked('x', 33.33),
      unlocked('a', 'Legendary'),
      unlocked('b', 'Rare'),
      unlocked('c', 'Common'),
    ];
    const b = [
      unlocked('c', 'Common'),
      unlocked('a', 'Legendary'),
      locked('x', 33.33),
      unlocked('b', 'Rare'),
    ];
    const wa = Object.fromEntries(
      computeOdds(a).computed.map((c) => [c.card_id, c.weight]),
    );
    const wb = Object.fromEntries(
      computeOdds(b).computed.map((c) => [c.card_id, c.weight]),
    );
    expect(wa).toEqual(wb);
    expect(sumWeight(computeOdds(a).computed)).toBe(TOTAL_BPS);
  });
});

describe('computeOdds — validation', () => {
  it('rejects when locked rates exceed 100%', () => {
    const { error } = computeOdds([locked('a', 60), locked('b', 50)]);
    expect(error).toMatch(/exceed 100%/i);
  });

  it('rejects when every card is locked but the total is not exactly 100%', () => {
    const { error } = computeOdds([locked('a', 40), locked('b', 40)]);
    expect(error).toMatch(/total exactly 100%/i);
  });

  it('accepts when every card is locked and the total is exactly 100%', () => {
    const { computed, error } = computeOdds([locked('a', 70), locked('b', 30)]);
    expect(error).toBeNull();
    expect(sumWeight(computed)).toBe(TOTAL_BPS);
  });

  it('allows locked cards to sum to 100% with unlocked cards going to 0%', () => {
    const entries = [locked('a', 100), unlocked('b'), unlocked('c')];
    const { computed, error } = computeOdds(entries);
    expect(error).toBeNull();
    const byId = Object.fromEntries(computed.map((c) => [c.card_id, c.weight]));
    expect(byId.a).toBe(TOTAL_BPS);
    expect(byId.b).toBe(0);
    expect(byId.c).toBe(0);
  });

  it('rejects an out-of-range locked percentage', () => {
    expect(computeOdds([locked('a', 150), unlocked('b')]).error).toMatch(
      /between 0% and 100%/i,
    );
    expect(computeOdds([locked('a', -5), unlocked('b')]).error).toMatch(
      /between 0% and 100%/i,
    );
  });

  it('rejects an empty entry set', () => {
    expect(computeOdds([]).error).toMatch(/no cards/i);
  });
});
