// src/lib/__tests__/price-tier.test.ts
import { describe, it, expect } from 'vitest';
import {
  priceTier,
  TIER_COLOR,
  TIER_BAND,
  TIER_ORDER,
  type Tier,
} from '../price-tier';

describe('priceTier', () => {
  it('buckets each band by upper-exclusive boundary', () => {
    expect(priceTier(0)).toBe('common');
    expect(priceTier(24.99)).toBe('common');
    expect(priceTier(25)).toBe('uncommon');
    expect(priceTier(99.99)).toBe('uncommon');
    expect(priceTier(100)).toBe('rare');
    expect(priceTier(499.99)).toBe('rare');
    expect(priceTier(500)).toBe('mythical');
    expect(priceTier(1999.99)).toBe('mythical');
    expect(priceTier(2000)).toBe('legendary');
    expect(priceTier(9999.99)).toBe('legendary');
    expect(priceTier(10000)).toBe('immortal');
    expect(priceTier(250000)).toBe('immortal');
  });

  it('treats non-finite and non-positive values as common (never immortal)', () => {
    expect(priceTier(Number.NaN)).toBe('common');
    expect(priceTier(Number.POSITIVE_INFINITY)).toBe('common');
    expect(priceTier(-5)).toBe('common');
  });

  it('TIER_COLOR has an RGB triple for every tier', () => {
    const tiers: Tier[] = [
      'common',
      'uncommon',
      'rare',
      'mythical',
      'legendary',
      'immortal',
    ];
    for (const t of tiers) {
      expect(TIER_COLOR[t]).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/);
    }
  });

  it('TIER_ORDER lists all six tiers low→high', () => {
    expect(TIER_ORDER).toEqual([
      'common',
      'uncommon',
      'rare',
      'mythical',
      'legendary',
      'immortal',
    ]);
  });

  it('TIER_BAND mirrors the priceTier thresholds exactly', () => {
    expect(TIER_BAND).toEqual({
      common: '< $25',
      uncommon: '$25 – 99',
      rare: '$100 – 499',
      mythical: '$500 – 1,999',
      legendary: '$2,000 – 9,999',
      immortal: '≥ $10,000',
    });
  });
});
