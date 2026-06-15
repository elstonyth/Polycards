import { describe, it, expect } from 'vitest';
import { money, usd, num } from '../format';

describe('money', () => {
  it('defaults to $ + 2dp', () => {
    expect(money(39.8)).toBe('$39.80');
    expect(money(1234.5)).toBe('$1,234.50');
  });
  it('0 decimals rounds and drops cents', () => {
    expect(money(40, { decimals: 0 })).toBe('$40');
    expect(money(1000.4, { decimals: 0 })).toBe('$1,000');
    expect(money(1000.5, { decimals: 0 })).toBe('$1,001');
  });
  it('custom prefix', () => {
    expect(money(39.8, { prefix: 'US$' })).toBe('US$39.80');
  });
  it('currency style matches Intl currency output', () => {
    expect(money(39.8, { currency: true })).toBe(
      (39.8).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    );
  });
});

// Lock the delegating aliases to their ORIGINAL output.
describe('aliases stay byte-identical', () => {
  it('usd == old currency-style', () => {
    for (const n of [0, 9.99, 312, 1284.5, 18420.75]) {
      expect(usd(n)).toBe(
        n.toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      );
    }
  });
  it('num unchanged', () => {
    expect(num(48250)).toBe((48250).toLocaleString('en-US'));
  });
});
