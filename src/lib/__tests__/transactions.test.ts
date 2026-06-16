import { describe, it, expect } from 'vitest';
import { reasonLabel, signedUsd } from '@/lib/transactions';

describe('reasonLabel', () => {
  it('maps each reason to a human label', () => {
    expect(reasonLabel('topup')).toBe('Top-up');
    expect(reasonLabel('pack_open')).toBe('Pack open');
    expect(reasonLabel('buyback')).toBe('Sell-back');
    expect(reasonLabel('adjustment')).toBe('Adjustment');
  });
});

describe('signedUsd', () => {
  it('prefixes a sign and formats the magnitude', () => {
    expect(signedUsd(48)).toBe('+$48.00');
    expect(signedUsd(-25)).toBe('-$25.00');
    expect(signedUsd(0)).toBe('$0.00');
  });
});
