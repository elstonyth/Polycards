import {
  balanceOdds,
  computeSetWeights,
  TOTAL_BPS,
  type SetEntry,
  type SetWeightsResult,
} from '../index';

type Row = SetWeightsResult['rows'][number];

const e = (
  card_id: string,
  pct: number,
  extra: Partial<SetEntry> = {},
): SetEntry => ({
  card_id,
  locked: false,
  pct,
  rarity: 'Rare',
  pct_2: null,
  pct_3: null,
  ...extra,
});
const common = (card_id: string, extra: Partial<SetEntry> = {}): SetEntry =>
  e(card_id, 0, { rarity: 'Common', ...extra });

// The storage rule read back: NULL means "inherit the previous set".
const resolved = (r: Row, set: 2 | 3): number =>
  set === 2 ? (r.weight_2 ?? r.weight) : (r.weight_3 ?? r.weight_2 ?? r.weight);
const resolvedSum = (rows: Row[], set: 2 | 3): number =>
  rows.reduce((sum, r) => sum + resolved(r, set), 0);
const byId = (rows: Row[]) => new Map(rows.map((r) => [r.card_id, r]));

describe('computeSetWeights — 3-set inheritance + balancer', () => {
  it('leaves sets 2/3 fully NULL when nothing is explicit (pure inheritance)', () => {
    const entries = [e('a', 20), e('b', 30), common('c')];
    const { error, rows } = computeSetWeights(entries);

    expect(error).toBeNull();
    expect(rows.map((r) => r.weight)).toEqual(
      balanceOdds(entries).computed.map((c) => c.weight),
    );
    expect(rows.every((r) => r.weight_2 === null && r.weight_3 === null)).toBe(
      true,
    );
  });

  it('materializes an explicit set-2 rate plus the Common balancer, and nothing else', () => {
    const { error, rows } = computeSetWeights([
      e('a', 20, { pct_2: 40 }),
      e('b', 30),
      common('c'),
    ]);
    const r = byId(rows);

    expect(error).toBeNull();
    expect(r.get('a')!.weight_2).toBe(4000); // explicit
    expect(r.get('b')!.weight_2).toBeNull(); // untouched → inherits set 1
    expect(r.get('c')!.weight_2).toBe(3000); // balancer absorbs the remainder
    expect(resolvedSum(rows, 2)).toBe(TOTAL_BPS);
  });

  it('chains set 3 off set 2 RESOLVED values, not set 1', () => {
    const { error, rows } = computeSetWeights([
      e('a', 20, { pct_2: 30 }),
      e('b', 30, { pct_3: 10 }),
      common('c'),
    ]);
    const r = byId(rows);

    expect(error).toBeNull();
    expect(r.get('a')!.weight_2).toBe(3000);
    // `a` has no explicit pct_3 and is not the balancer → stays NULL, and the
    // fallback chain resolves it to set 2's 30% (NOT set 1's 20%).
    expect(r.get('a')!.weight_3).toBeNull();
    expect(resolved(r.get('a')!, 3)).toBe(3000);
    expect(r.get('b')!.weight_3).toBe(1000);
    expect(r.get('c')!.weight_3).toBe(6000); // 10000 − 3000 − 1000
    expect(resolvedSum(rows, 3)).toBe(TOTAL_BPS);
  });

  it('skips an empty set 2 without breaking set 3 (double fallback 3→2→1)', () => {
    const { error, rows } = computeSetWeights([
      e('a', 20, { pct_3: 10 }),
      e('b', 30),
      common('c'),
    ]);
    const r = byId(rows);

    expect(error).toBeNull();
    // Set 2 has no override anywhere → stays entirely NULL, and set 3's
    // effective rates come off set 1 (b = 30) rather than off nothing.
    expect(rows.every((row) => row.weight_2 === null)).toBe(true);
    expect(r.get('a')!.weight_3).toBe(1000);
    expect(r.get('b')!.weight_3).toBeNull();
    expect(resolved(r.get('b')!, 3)).toBe(3000);
    expect(r.get('c')!.weight_3).toBe(6000);
    expect(resolvedSum(rows, 3)).toBe(TOTAL_BPS);
  });

  it('labels a set-2 failure with its set number', () => {
    const { error, rows } = computeSetWeights([
      e('a', 20, { pct_2: 60 }),
      e('b', 30, { pct_2: 60 }),
      common('c'),
    ]);

    expect(error).toMatch(/^Set 2: /);
    expect(error).toMatch(/Common win rate would go below 0%/i);
    expect(rows).toEqual([]);
  });

  it('propagates a set-1 failure unprefixed', () => {
    const { error, rows } = computeSetWeights([
      e('a', 60),
      e('b', 50),
      common('c'),
    ]);

    expect(error).toMatch(/Common win rate would go below 0%/i);
    expect(error).not.toMatch(/^Set /);
    expect(rows).toEqual([]);
  });

  it('treats an explicit pct_2 of 0 as a real rate, not as inherit', () => {
    const { rows } = computeSetWeights([
      e('a', 20, { pct_2: 0 }),
      e('b', 30),
      common('c'),
    ]);
    const r = byId(rows);

    expect(r.get('a')!.weight_2).toBe(0);
    expect(r.get('a')!.weight_2).not.toBeNull();
    expect(r.get('c')!.weight_2).toBe(7000); // 10000 − 0 − 3000 inherited
    expect(resolvedSum(rows, 2)).toBe(TOTAL_BPS);
  });
});
