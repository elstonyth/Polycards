import { describe, expect, it } from 'vitest';
import { canCreditFromEntry } from './credit-from-entry';

describe('canCreditFromEntry', () => {
  it.each(['failed', 'expired'])('offers it on a %s USDT top-up', (status) => {
    expect(canCreditFromEntry({ status, currency: 'USDT' })).toBe(true);
  });

  it.each(['pending', 'settled'])('not on a %s USDT top-up', (status) => {
    expect(canCreditFromEntry({ status, currency: 'USDT' })).toBe(false);
  });

  it.each(['MYR', 'SGD'])('not on a %s top-up', (currency) => {
    expect(canCreditFromEntry({ status: 'expired', currency })).toBe(false);
  });
});
