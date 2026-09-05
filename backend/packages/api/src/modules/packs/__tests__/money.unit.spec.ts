import {
  toMoney,
  toSen,
  fromSen,
  pctOfSen,
  netOfFee,
  toOptionalMoney,
} from '../money';

describe('toMoney', () => {
  it('passes through a plain number', () => {
    expect(toMoney(12.34)).toBe(12.34);
  });
  it('coerces a numeric string (numeric column shape)', () => {
    expect(toMoney('0.15')).toBe(0.15);
  });
  it('coerces a BigNumber-like value via its numeric valueOf', () => {
    expect(toMoney({ valueOf: () => 7.5 } as unknown as number)).toBe(7.5);
  });
  it('preserves Number() semantics for null/undefined', () => {
    // Behavior-preserving: current call sites use Number(x);
    // Number(null)=0, Number(undefined)=NaN. Lock that exact behavior.
    expect(toMoney(null)).toBe(0);
    expect(Number.isNaN(toMoney(undefined))).toBe(true);
  });
});

describe('toSen', () => {
  it('converts a decimal to integer sen (half-up)', () => {
    expect(toSen(12.34)).toBe(1234);
    expect(toSen(0.1)).toBe(10);
    expect(toSen(3)).toBe(300);
    expect(toSen('2.5')).toBe(250);
  });

  it('rounds half-up at the sen boundary', () => {
    expect(toSen(0.005)).toBe(1); // Math.round(0.5) -> 1
  });

  it('handles signed amounts (spend is negative)', () => {
    expect(toSen(-1.5)).toBe(-150);
  });

  it('rounds negative half-sen away from zero (matches Postgres ROUND)', () => {
    expect(toSen(-0.005)).toBe(-1); // not -0 like bare Math.round
  });
});

describe('fromSen', () => {
  it('converts integer sen back to a 2dp number', () => {
    expect(fromSen(1234)).toBe(12.34);
    expect(fromSen(60)).toBe(0.6);
    expect(fromSen(0)).toBe(0);
  });
});

describe('pctOfSen', () => {
  it('takes a whole-percent of a sen amount, staying in sen (half-up)', () => {
    expect(pctOfSen(10000, 5)).toBe(500); // 5% of RM100 = RM5.00
    expect(pctOfSen(10000, 20)).toBe(2000); // 20% override of RM100
    expect(pctOfSen(300, 20)).toBe(60); // 20% of RM3.00 = RM0.60
  });

  it('rounds half-up', () => {
    expect(pctOfSen(333, 20)).toBe(67); // Math.round(66.6) -> 67
  });
});

describe('toOptionalMoney', () => {
  it('keeps absent and zero apart: blank is null, 0 is 0', () => {
    expect(toOptionalMoney('')).toBeNull();
    expect(toOptionalMoney(null)).toBeNull();
    expect(toOptionalMoney(undefined)).toBeNull();
    expect(toOptionalMoney('abc')).toBeNull();
    expect(toOptionalMoney(0)).toBe(0);
    expect(toOptionalMoney('49.40')).toBe(49.4);
  });
});

describe('netOfFee', () => {
  it('is gross minus fee at 2 dp, and unknown when either side is missing', () => {
    expect(netOfFee(50, 1)).toBe(49);
    expect(netOfFee('51.00', '0.61')).toBe(50.39);
    expect(netOfFee(0.1, 0.03)).toBe(0.07);
    expect(netOfFee(50, null)).toBeNull();
    expect(netOfFee('', 1)).toBeNull();
    expect(netOfFee(50, 'n/a')).toBeNull();
  });
});
