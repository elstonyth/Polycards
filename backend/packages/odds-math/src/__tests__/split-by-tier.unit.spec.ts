import {
  balanceOdds,
  DEFAULT_TIER_PCT,
  MIN_PCT,
  splitByTier,
  TOTAL_UNITS,
  type OddsInput,
  type TierSplitRow,
} from '../index';

const row = (
  card_id: string,
  rarity: string,
  locked = false,
): TierSplitRow => ({ card_id, locked, rarity });

const pctOf = (r: ReturnType<typeof splitByTier>, id: string) =>
  r.computed.find((c) => c.card_id === id)?.pct;

const tierOf = (r: ReturnType<typeof splitByTier>, rarity: string) =>
  r.tiers.find((t) => t.rarity === rarity);

// The full ladder, one card per tier — the shape the defaults are written for.
const FULL = [
  row('imm', 'Immortal'),
  row('leg', 'Legendary'),
  row('myth', 'Mythical'),
  row('rare', 'Rare'),
  row('unc', 'Uncommon'),
  row('com', 'Common'),
];

describe('DEFAULT_TIER_PCT', () => {
  it('sums to exactly 100%', () => {
    const total = Object.values(DEFAULT_TIER_PCT).reduce((s, n) => s + n, 0);
    expect(Math.round(total * 100) / 100).toBe(100);
  });
});

describe('splitByTier', () => {
  it('gives each tier its whole share when it holds one card', () => {
    const r = splitByTier(FULL);
    expect(pctOf(r, 'imm')).toBe(0.1);
    expect(pctOf(r, 'leg')).toBe(1.4);
    expect(pctOf(r, 'myth')).toBe(3.5);
    expect(pctOf(r, 'rare')).toBe(22);
    expect(pctOf(r, 'unc')).toBe(30);
  });

  it('splits a tier evenly between its cards (the spec examples)', () => {
    const r = splitByTier([
      row('i1', 'Immortal'),
      row('i2', 'Immortal'),
      row('l1', 'Legendary'),
      row('l2', 'Legendary'),
      row('c', 'Common'),
    ]);
    expect(pctOf(r, 'i1')).toBe(0.05);
    expect(pctOf(r, 'i2')).toBe(0.05);
    expect(pctOf(r, 'l1')).toBe(0.7);
    expect(pctOf(r, 'l2')).toBe(0.7);
  });

  it('never writes a rate for an unlocked Common — it is the balancer', () => {
    const r = splitByTier(FULL);
    expect(pctOf(r, 'com')).toBeUndefined();
    expect(tierOf(r, 'Common')?.balancerCount).toBe(1);
  });

  it('leaves locked rows alone — they keep their own rate', () => {
    const r = splitByTier([
      row('r1', 'Rare'),
      { ...row('r2', 'Rare', true), pct: 10 },
      row('c', 'Common'),
    ]);
    expect(pctOf(r, 'r2')).toBeUndefined();
  });

  // A locked card SPENDS its tier's budget. Otherwise a partly-locked tier
  // quietly costs more than its share while the panel still reports the budget.
  it('makes a locked card spend its tier budget, not add to it', () => {
    const r = splitByTier([
      row('r1', 'Rare'),
      row('r2', 'Rare'),
      { ...row('r3', 'Rare', true), pct: 10 },
      row('c', 'Common'),
    ]);
    // 22% budget − 10% locked = 12% left, split between the two free Rares.
    expect(pctOf(r, 'r1')).toBe(6);
    expect(pctOf(r, 'r2')).toBe(6);
    const tier = tierOf(r, 'Rare');
    expect(tier?.count).toBe(2);
    expect(tier?.lockedCount).toBe(1);
    expect(tier?.lockedPct).toBe(10);
    // The tier costs exactly its share: 6 + 6 + 10 === 22.
    expect(6 + 6 + tier!.lockedPct).toBe(tier!.budgetPct);
    expect(tier?.overspent).toBe(false);
  });

  it('flags a tier whose locks already exceed its share', () => {
    const r = splitByTier([
      row('r1', 'Rare'),
      { ...row('r2', 'Rare', true), pct: 30 },
      row('c', 'Common'),
    ]);
    const tier = tierOf(r, 'Rare');
    expect(tier?.overspent).toBe(true);
    // Nothing left, so the free Rare would be unpullable — floored instead.
    expect(tier?.floored).toBe(true);
    expect(pctOf(r, 'r1')).toBe(MIN_PCT);
  });

  // An all-locked tier is NOT an empty tier. Reporting it as "no cards" was the
  // panel contradicting the table below it.
  it('distinguishes an all-locked tier from an empty one', () => {
    const r = splitByTier([
      { ...row('r1', 'Rare', true), pct: 5 },
      { ...row('r2', 'Rare', true), pct: 5 },
      row('c', 'Common'),
    ]);
    const rare = tierOf(r, 'Rare');
    expect(rare?.count).toBe(0);
    expect(rare?.lockedCount).toBe(2);
    expect(rare?.lockedPct).toBe(10);
    // Only the UNSPENT 12% falls to the balancer — not the whole 22%.
    // Plus the four genuinely empty tiers: 0.1 + 1.4 + 3.5 + 30 = 35.
    expect(r.unusedPct).toBeCloseTo(12 + 35, 10);
    expect(tierOf(r, 'Legendary')?.lockedCount).toBe(0);
  });

  it('reports an empty tier as unused budget, absorbed by Common', () => {
    const noLegendary = FULL.filter((r) => r.rarity !== 'Legendary');
    const r = splitByTier(noLegendary);
    expect(r.unusedPct).toBe(1.4);
    expect(tierOf(r, 'Legendary')?.count).toBe(0);
  });

  it('raises a sub-1-unit share to the floor and flags the tier', () => {
    // 0.1% across 2000 Immortals is 0.00005% each — under MIN_PCT (0.0001%),
    // so every one would round to weight 0 and become unpullable.
    const many = Array.from({ length: 2000 }, (_, i) =>
      row(`i${i}`, 'Immortal'),
    ).concat(row('c', 'Common'));
    const r = splitByTier(many);
    expect(tierOf(r, 'Immortal')?.floored).toBe(true);
    expect(pctOf(r, 'i0')).toBe(MIN_PCT);
  });

  it('honours an edited tier table', () => {
    const r = splitByTier(FULL, { ...DEFAULT_TIER_PCT, Rare: 10 });
    expect(pctOf(r, 'rare')).toBe(10);
  });

  // A deliberate 0 is an edit, not an under-floor split. Rounding it up to
  // MIN_PCT would silently refuse what the operator typed.
  it('honours a 0% tier instead of flooring it, and flags the cards', () => {
    const r = splitByTier(FULL, { ...DEFAULT_TIER_PCT, Rare: 0 });
    expect(pctOf(r, 'rare')).toBe(0);
    const tier = tierOf(r, 'Rare');
    expect(tier?.zeroed).toBe(true);
    expect(tier?.floored).toBe(false);
  });

  it('degrades instead of throwing on junk input', () => {
    expect(splitByTier(null as never).computed).toEqual([]);
    // An unusable budget is treated as 0 — and flagged, never silently floored.
    const r = splitByTier(FULL, { ...DEFAULT_TIER_PCT, Rare: NaN });
    expect(pctOf(r, 'rare')).toBe(0);
    expect(tierOf(r, 'Rare')?.zeroed).toBe(true);
  });
});

// The preset's whole contract is "hand these to balanceOdds and Σ is 100%".
describe('splitByTier → balanceOdds', () => {
  const applied = (rows: TierSplitRow[]): OddsInput[] => {
    const r = splitByTier(rows);
    const byId = new Map(r.computed.map((c) => [c.card_id, c.pct]));
    return rows.map((x) => ({
      card_id: x.card_id,
      locked: x.locked,
      rarity: x.rarity,
      pct: byId.get(x.card_id) ?? 0,
    }));
  };

  it('totals exactly 100% with the full ladder', () => {
    const res = balanceOdds(applied(FULL));
    expect(res.error).toBeNull();
    const sum = res.computed.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBe(TOTAL_UNITS);
    // Every tier present ⇒ Common lands on exactly its documented share.
    expect(res.computed.find((c) => c.card_id === 'com')?.pct).toBe(43);
  });

  it('pushes an empty tier’s share into Common, still totalling 100%', () => {
    const noLegendary = FULL.filter((r) => r.rarity !== 'Legendary');
    const res = balanceOdds(applied(noLegendary));
    expect(res.error).toBeNull();
    expect(res.computed.reduce((s, c) => s + c.weight, 0)).toBe(TOTAL_UNITS);
    expect(res.computed.find((c) => c.card_id === 'com')?.pct).toBe(44.4);
  });
});
