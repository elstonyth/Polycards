import { describe, expect, it } from 'vitest';
import { delta, flowLine, signed } from './signs';

describe('signed', () => {
  it('writes a minus sign in front of the currency, never inside it', () => {
    expect(signed(-1234)).toBe('− RM 1,234.00');
    expect(signed(5)).toBe('RM 5.00');
    expect(signed(0)).toBe('RM 0.00');
    expect(signed(-0)).toBe('RM 0.00');
  });
});

describe('flowLine', () => {
  it('money out: paid out reads −, taken back reads +', () => {
    expect(flowLine(50, true)).toBe('− RM 50.00');
    expect(flowLine(-50, true)).toBe('+ RM 50.00');
    expect(flowLine(0, true)).toBe('RM 0.00');
  });
  it('money in: received reads plain, refunded reads −', () => {
    expect(flowLine(50, false)).toBe('RM 50.00');
    expect(flowLine(-50, false)).toBe('− RM 50.00');
  });
});

describe('delta', () => {
  it('a gap reads with its own sign in front: + RM x, − RM x', () => {
    expect(delta(-111.81)).toBe('− RM 111.81');
    expect(delta(12)).toBe('+ RM 12.00');
    expect(delta(0)).toBe('RM 0.00');
  });
});
