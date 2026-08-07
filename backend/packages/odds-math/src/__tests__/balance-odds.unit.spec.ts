import { balanceOdds, TOTAL_UNITS } from '../index';

const e = (card_id: string, pct: number, rarity = 'Rare', locked = false) => ({
  card_id,
  locked,
  pct,
  rarity,
});
const common = (card_id: string, pct = 0, locked = false) => ({
  card_id,
  locked,
  pct,
  rarity: 'Common',
});

describe('balanceOdds — Common absorbs the remainder', () => {
  it('gives Common everything the pinned rows leave (20+30 → Common 50%)', () => {
    const r = balanceOdds([e('a', 20), e('b', 30), common('c')]);
    expect(r.error).toBeNull();
    expect(r.computed.map((c) => c.weight)).toEqual([
      200_000, 300_000, 500_000,
    ]);
  });
  it('splits the remainder evenly across unlocked Commons with largest-remainder', () => {
    const r = balanceOdds([
      e('a', 10),
      common('c1'),
      common('c2'),
      common('c3'),
    ]);
    expect(r.computed.map((c) => c.weight)).toEqual([
      100_000, 300_000, 300_000, 300_000,
    ]);
    const r2 = balanceOdds([
      e('a', 33.33),
      e('b', 33.33),
      common('c1'),
      common('c2'),
    ]);
    expect(r2.computed.map((c) => c.weight)).toEqual([
      333_300, 333_300, 166_700, 166_700,
    ]);
  });
  it('hands the indivisible leftover unit to the lowest card_id', () => {
    const r = balanceOdds([common('c1'), common('c2'), common('c3')]);
    expect(r.error).toBeNull();
    expect(r.computed.map((c) => c.weight)).toEqual([
      333_334, 333_333, 333_333,
    ]);
    expect(r.computed.reduce((s, c) => s + c.weight, 0)).toBe(TOTAL_UNITS);
  });
  it('honors a LOCKED Common verbatim; unlocked Commons absorb the rest', () => {
    const r = balanceOdds([common('pin', 10, true), e('a', 20), common('bal')]);
    expect(r.computed.map((c) => c.weight)).toEqual([
      100_000, 200_000, 700_000,
    ]);
  });
  it('keeps a 4-decimal rate exact (0.6842% → 6842 units → 0.6842%)', () => {
    const r = balanceOdds([e('a', 0.6842), e('b', 0.0001), common('c')]);
    expect(r.error).toBeNull();
    const byId = new Map(r.computed.map((c) => [c.card_id, c]));
    expect(byId.get('a')!.weight).toBe(6842);
    expect(byId.get('a')!.pct).toBe(0.6842);
    expect(byId.get('b')!.weight).toBe(1);
    expect(byId.get('b')!.pct).toBe(0.0001);
    expect(byId.get('c')!.weight).toBe(TOTAL_UNITS - 6843);
    expect(r.computed.reduce((s, c) => s + c.weight, 0)).toBe(TOTAL_UNITS);
  });
  it('blocks save when Common would go below 0%', () => {
    const r = balanceOdds([e('a', 60), e('b', 50), common('c')]);
    expect(r.error).toMatch(/over the 100% budget/i);
  });
  it('without an unlocked Common, rates must total exactly 100%', () => {
    expect(balanceOdds([e('a', 40), e('b', 50)]).error).toMatch(
      /total exactly 100%/i,
    );
    expect(balanceOdds([e('a', 40), e('b', 60)]).error).toBeNull();
  });
  it('rejects out-of-range pinned rates and empty input', () => {
    expect(balanceOdds([e('a', 101), common('c')]).error).toMatch(
      /between 0% and 100%/i,
    );
    expect(balanceOdds([]).error).toMatch(/no cards/i);
  });
  it('is input-order independent', () => {
    const rows = [e('a', 12.5), common('c2'), e('b', 30), common('c1')];
    const a = balanceOdds(rows);
    const b = balanceOdds([...rows].reverse());
    const byId = (r: typeof a) =>
      new Map(r.computed.map((c) => [c.card_id, c.weight]));
    expect(byId(a)).toEqual(byId(b));
  });
  it('property: any pinned combination sums to exactly TOTAL_UNITS or errors (seeded fuzz)', () => {
    let seed = 42;
    let clean = 0;
    const rand = () =>
      (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 200; i++) {
      const n = 2 + Math.floor(rand() * 6);
      const rows = Array.from({ length: n }, (_, j) =>
        j === 0 ? common(`c${j}`) : e(`p${j}`, Math.floor(rand() * 6000) / 100),
      );
      const r = balanceOdds(rows);
      if (r.error === null) {
        clean += 1;
        expect(r.computed.reduce((s, c) => s + c.weight, 0)).toBe(TOTAL_UNITS);
        expect(r.computed.every((c) => c.weight >= 0)).toBe(true);
      }
    }
    // Non-vacuity guard: the assertions above sit behind `error === null`, so a
    // generator that only ever produced invalid rows would pass asserting nothing.
    expect(clean).toBeGreaterThan(0);
  });
});
