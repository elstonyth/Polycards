import {
  validateDailyBox, computeBoxWeights, pickPrize, MAX_BOX_CREDIT_MYR,
  type BoxPrizeInput,
} from '../daily-box';

const credit = (amount: number, locked = false, pct = 0): BoxPrizeInput =>
  ({ kind: 'credit', locked, pct, amount_myr: amount });

describe('validateDailyBox', () => {
  const base = {
    name: 'Bronze', enabled: true, draws_per_day: 1, reason: 'authoring',
    prizes: [credit(5)],
  };
  test('accepts a valid body', () => {
    expect(validateDailyBox(base).prizes).toHaveLength(1);
  });
  test('rejects enabled box with no prizes', () => {
    expect(() => validateDailyBox({ ...base, prizes: [] })).toThrow(/prize/i);
  });
  test('allows disabled box with no prizes', () => {
    expect(validateDailyBox({ ...base, enabled: false, prizes: [] }).enabled).toBe(false);
  });
  test('enforces the credit ceiling on credit and voucher kinds', () => {
    expect(() => validateDailyBox({ ...base, prizes: [credit(MAX_BOX_CREDIT_MYR + 1)] })).toThrow(/ceiling|10,?000/i);
    expect(() => validateDailyBox({
      ...base,
      prizes: [{ kind: 'voucher', locked: false, pct: 0, amount_myr: MAX_BOX_CREDIT_MYR + 1 }],
    })).toThrow(/ceiling|10,?000/i);
  });
  test('product prizes need handle and qty', () => {
    expect(() => validateDailyBox({
      ...base, prizes: [{ kind: 'product', locked: false, pct: 0, qty: 1 }],
    })).toThrow(/product/i);
    expect(() => validateDailyBox({
      ...base, prizes: [{ kind: 'product', locked: false, pct: 0, product_handle: 'pikachu', qty: 0 }],
    })).toThrow(/qty/i);
  });
  test('product prizes restrict qty to 1 (multi-qty not yet supported)', () => {
    expect(() => validateDailyBox({
      ...base, prizes: [{ kind: 'product', locked: false, pct: 0, product_handle: 'pikachu', qty: 2 }],
    })).toThrow(/qty/i);
    expect(validateDailyBox({
      ...base, prizes: [{ kind: 'product', locked: false, pct: 0, product_handle: 'pikachu', qty: 1 }],
    }).prizes[0]).toMatchObject({ qty: 1 });
  });
  test('draws_per_day bounds 1..10 and mandatory reason', () => {
    expect(() => validateDailyBox({ ...base, draws_per_day: 0 })).toThrow();
    expect(() => validateDailyBox({ ...base, draws_per_day: 11 })).toThrow();
    expect(() => validateDailyBox({ ...base, reason: '' })).toThrow(/reason/i);
  });
});

describe('computeBoxWeights', () => {
  test('locked prize pins pct; unlocked share remainder equally', () => {
    const w = computeBoxWeights([
      credit(100, true, 90),
      credit(1), credit(2),
    ]);
    expect(w[0]).toEqual({ weight: 900_000, locked: true });
    expect(w[1].weight + w[2].weight).toBe(100_000);
    expect(Math.abs(w[1].weight - w[2].weight)).toBeLessThanOrEqual(1); // equal-ish split
  });
  test('weights always sum to 1,000,000', () => {
    const w = computeBoxWeights([credit(1), credit(2), credit(3)]);
    expect(w.reduce((a, b) => a + b.weight, 0)).toBe(1_000_000);
  });
  test('throws when locked total exceeds 100%', () => {
    expect(() => computeBoxWeights([credit(1, true, 60), credit(2, true, 50)])).toThrow();
  });
});

describe('pickPrize', () => {
  const rows = [{ weight: 9000, id: 'a' }, { weight: 1000, id: 'b' }];
  test('roll below first weight picks first', () => {
    expect(pickPrize(rows, 0).id).toBe('a');
    expect(pickPrize(rows, 8999).id).toBe('a');
  });
  test('roll at boundary picks second', () => {
    expect(pickPrize(rows, 9000).id).toBe('b');
    expect(pickPrize(rows, 9999).id).toBe('b');
  });
  test('throws when weights do not cover the roll', () => {
    expect(() => pickPrize([{ weight: 500 }], 9999)).toThrow();
  });
});
