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
