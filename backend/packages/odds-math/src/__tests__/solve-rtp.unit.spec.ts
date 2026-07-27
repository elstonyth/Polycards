import { solveOddsForRtp, type RtpSolveRow } from '../index';

// A pool with NO sub-1-bps rates, so this task's math is testable without the
// floor cascade: two cheap Commons and one modest chase card.
const SIMPLE: RtpSolveRow[] = [
  { card_id: 'cheap-a', locked: false, rarity: 'Common', value: 20, pct: 0 },
  { card_id: 'cheap-b', locked: false, rarity: 'Common', value: 40, pct: 0 },
  { card_id: 'chase', locked: false, rarity: 'Rare', value: 500, pct: 0 },
];

const pctOf = (r: ReturnType<typeof solveOddsForRtp>, id: string) =>
  r.computed.find((c) => c.card_id === id)?.pct ?? Number.NaN;

describe('solveOddsForRtp', () => {
  it('hits the target RTP exactly when nothing needs flooring', () => {
    const res = solveOddsForRtp(SIMPLE, 50, 0.7);
    expect(res.error).toBeNull();
    expect(res.achievedRtp).toBeCloseTo(0.7, 6);
    // Commons average 30; chase is 500. EV 35 => c = 5/470.
    expect(pctOf(res, 'chase')).toBeCloseTo((5 / 470) * 100, 6);
    expect(res.floored).toEqual([]);
  });

  it('always totals 100%', () => {
    const res = solveOddsForRtp(SIMPLE, 50, 0.7);
    const total = res.computed.reduce((s, c) => s + c.pct, 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it('leaves locked rows untouched and solves over the rest', () => {
    const rows: RtpSolveRow[] = [
      { card_id: 'pinned', locked: true, rarity: 'Rare', value: 500, pct: 2 },
      ...SIMPLE,
    ];
    const res = solveOddsForRtp(rows, 50, 0.9);
    expect(res.error).toBeNull();
    expect(pctOf(res, 'pinned')).toBe(2);
    expect(res.achievedRtp).toBeCloseTo(0.9, 6);
  });

  it('reports the reachable band instead of clamping an impossible target', () => {
    const res = solveOddsForRtp(SIMPLE, 50, 0.1);
    expect(res.computed).toEqual([]);
    expect(res.error).toMatch(/this pool reaches/);
    expect(res.error).toMatch(/Lower the target, raise the price/);
  });

  it('errors cleanly on degenerate pools', () => {
    const noAbsorber: RtpSolveRow[] = [
      { card_id: 'a', locked: false, rarity: 'Rare', value: 100, pct: 0 },
    ];
    expect(solveOddsForRtp(noAbsorber, 50, 0.7).error).toMatch(/unlocked Common/);

    const noChase: RtpSolveRow[] = [
      { card_id: 'a', locked: false, rarity: 'Common', value: 100, pct: 0 },
    ];
    expect(solveOddsForRtp(noChase, 50, 0.7).error).toMatch(/non-Common/);

    const sameValue: RtpSolveRow[] = [
      { card_id: 'a', locked: false, rarity: 'Common', value: 100, pct: 0 },
      { card_id: 'b', locked: false, rarity: 'Rare', value: 100, pct: 0 },
    ];
    expect(solveOddsForRtp(sameValue, 50, 0.7).error).toMatch(/same average value/);

    expect(solveOddsForRtp(SIMPLE, 0, 0.7).error).toMatch(/Pack price/);
    expect(solveOddsForRtp([], 50, 0.7).error).toMatch(/No cards/);
  });

  it('rejects a locked row whose rate is not a usable number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 101]) {
      const rows: RtpSolveRow[] = [
        { card_id: 'pinned', locked: true, rarity: 'Rare', value: 500, pct: bad },
        ...SIMPLE,
      ];
      const res = solveOddsForRtp(rows, 50, 0.7);
      expect(res.error).toMatch(/Locked win rates must each be/);
      expect(res.computed).toEqual([]);
      expect(res.achievedRtp).toBeNull();
    }
  });

  it('ignores an unusable rate on an UNLOCKED row', () => {
    const rows: RtpSolveRow[] = [
      { card_id: 'chase', locked: false, rarity: 'Rare', value: 500, pct: Number.NaN },
      { card_id: 'cheap-a', locked: false, rarity: 'Common', value: 20, pct: 0 },
      { card_id: 'cheap-b', locked: false, rarity: 'Common', value: 40, pct: 0 },
    ];
    const res = solveOddsForRtp(rows, 50, 0.7);
    expect(res.error).toBeNull();
    expect(res.achievedRtp).toBeCloseTo(0.7, 6);
  });
});

import { MIN_PCT, RARITY_WEIGHT } from '../index';

// The real bronze-pack pool with corrected (value-banded) rarities.
const BRONZE: RtpSolveRow[] = [
  { card_id: 'pw-pikachu', locked: false, rarity: 'Common', value: 24.55, pct: 0 },
  { card_id: 'pw-bulbasaur', locked: false, rarity: 'Common', value: 39.27, pct: 0 },
  { card_id: 'pw-jolteon', locked: false, rarity: 'Uncommon', value: 122.73, pct: 0 },
  { card_id: 'pw-gengar', locked: false, rarity: 'Rare', value: 589.1, pct: 0 },
  { card_id: 'pw-charizard', locked: false, rarity: 'Rare', value: 1718.22, pct: 0 },
  { card_id: 'mega-dragonite', locked: false, rarity: 'Rare', value: 1829.51, pct: 0 },
  { card_id: 'pw-mewtwo', locked: false, rarity: 'Mythical', value: 4418.28, pct: 0 },
  { card_id: 'pikachu-grey-felt', locked: false, rarity: 'Mythical', value: 4856.08, pct: 0 },
  { card_id: 'pikachu-ex-238', locked: false, rarity: 'Mythical', value: 4860.11, pct: 0 },
  { card_id: 'mega-charizard-x', locked: false, rarity: 'Legendary', value: 9867.49, pct: 0 },
];

// A pool where pass 0 floors one row (an Immortal so valuable that even its
// forced MIN_PCT contributes huge EV) and pass 1 -- solving over the rows
// still free -- is infeasible. Exercises the cascade's infeasible-band
// branch on a pass AFTER at least one row has already floored, which the
// single-pass Task 2 band test cannot reach (nothing floors there).
const INFEASIBLE_AFTER_FLOOR: RtpSolveRow[] = [
  { card_id: 'cheap-a', locked: false, rarity: 'Common', value: 20, pct: 0 },
  { card_id: 'cheap-b', locked: false, rarity: 'Common', value: 40, pct: 0 },
  { card_id: 'the-one', locked: false, rarity: 'Immortal', value: 1_000_000, pct: 0 },
  { card_id: 'a-rare', locked: false, rarity: 'Rare', value: 300, pct: 0 },
];

describe('solveOddsForRtp — 1 bps floor', () => {
  it('never emits a chase row below the floor', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    expect(res.error).toBeNull();
    const chase = res.computed.filter((c) => !['pw-pikachu', 'pw-bulbasaur'].includes(c.card_id));
    for (const row of chase) expect(row.pct).toBeGreaterThanOrEqual(MIN_PCT);
  });

  it('cascades: the Legendary floors first, then all three Mythicals', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    const ids = res.floored.map((f) => f.card_id).sort();
    expect(ids).toEqual(
      ['mega-charizard-x', 'pikachu-ex-238', 'pikachu-grey-felt', 'pw-mewtwo'].sort(),
    );
  });

  it('reports fair vs applied for each floored row', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    const legendary = res.floored.find((f) => f.card_id === 'mega-charizard-x');
    expect(legendary).toBeDefined();
    expect(legendary!.appliedPct).toBe(MIN_PCT);
    expect(legendary!.fairPct).toBeLessThan(MIN_PCT);
  });

  it('overshoots the target upward, never downward', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    // Epsilon: achievedRtp is re-derived by summing pct/100 * value across 10
    // rows then dividing by packPrice, so it lands within a couple of ULPs of
    // 0.7 (observed 0.6999999999999998) rather than exactly on it. Same field
    // is compared with toBeCloseTo(x, 6) elsewhere in this file; this is that
    // tolerance, not a relaxation of the "never downward" claim.
    expect(res.achievedRtp).toBeGreaterThanOrEqual(0.7 - 1e-9);
    expect(res.achievedRtp).toBeLessThan(0.72);
  });

  it('flags the tier collapse when two tiers both sit at the floor', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    expect(res.tierCollapse).toEqual(['Legendary', 'Mythical']);
  });

  it('still totals 100% after flooring', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    const total = res.computed.reduce((s, c) => s + c.pct, 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it('reports nothing floored on a pool that does not need it', () => {
    const res = solveOddsForRtp(SIMPLE, 50, 0.7);
    expect(res.floored).toEqual([]);
    expect(res.tierCollapse).toEqual([]);
    expect(res.achievedRtp).toBeCloseTo(0.7, 6);
  });

  it('keeps the ladder ordering among rows that did not floor', () => {
    const res = solveOddsForRtp(BRONZE, 50, 0.7);
    const pct = (id: string) => res.computed.find((c) => c.card_id === id)!.pct;
    // Uncommon (weight 300) must stay above Rare (weight 150).
    expect(RARITY_WEIGHT.Uncommon).toBeGreaterThan(RARITY_WEIGHT.Rare);
    expect(pct('pw-jolteon')).toBeGreaterThan(pct('pw-gengar'));
  });

  it('scopes the infeasible-band bound to the rows still FREE on that pass, not the original group', () => {
    // Pass 0 (free = {the-one, a-rare}): the-one's fair share (~0.00072%) is
    // far below MIN_PCT, so it floors; a-rare's fair share (~0.108%) clears
    // it easily and stays free. Pass 1 (free = {a-rare} only): the-one's
    // forced floor EV alone (MIN_PCT/100 * 1,000,000 = RM 100) already
    // exceeds the target EV (RM 37.5), so even 0% further chase mass
    // overshoots -- infeasible on the low side.
    const res = solveOddsForRtp(INFEASIBLE_AFTER_FLOOR, 50, 0.75);
    expect(res.error).toMatch(/this pool reaches/);

    const match = res.error!.match(
      /this pool reaches RM ([\d.]+)-RM ([\d.]+) \(([\d.]+)%-([\d.]+)%\)/,
    );
    expect(match).not.toBeNull();
    const maxEv = Number(match![2]);
    const maxPct = Number(match![4]);

    // Correct bound: flooredEv (RM 100, from the-one pinned at MIN_PCT) plus
    // the remaining free mass valued at the FREE mean (a-rare alone, RM 300)
    // -> ~RM 399.97 / ~799.94%. A regression back to using the pre-loop `vH`
    // (the mean over {the-one, a-rare} BEFORE flooring, ~6920.53) would
    // print ~RM 7019.84 / ~14039.68% instead -- off by ~18x, since it values
    // the free mass as if the already-floored, far-more-valuable Immortal
    // were still competing for it.
    expect(maxEv).toBeCloseTo(399.97, 1);
    expect(maxPct).toBeCloseTo(799.94, 1);
  });
});
