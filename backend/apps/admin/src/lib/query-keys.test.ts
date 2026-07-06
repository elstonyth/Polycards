import { describe, it, expect } from 'vitest';
import { qk } from './query-keys';

describe('qk', () => {
  it('exposes the static list keys', () => {
    expect(qk.packs).toEqual(['admin', 'packs']);
    expect(qk.cards).toEqual(['admin', 'cards']);
    expect(qk.pulls(0)).toEqual(['admin', 'pulls', 0]);
    expect(qk.pullsKey).toEqual(['admin', 'pulls']);
    expect(qk.economy).toEqual(['admin', 'economy']);
    expect(qk.eligibleProducts).toEqual(['admin', 'eligible-products']);
  });

  it('nests odds under the pack key so a pack invalidation can target odds', () => {
    expect(qk.pack('starter')).toEqual(['admin', 'pack', 'starter']);
    expect(qk.packOdds('starter')).toEqual(['admin', 'pack', 'starter', 'odds']);
  });

  it('builds a per-customer gacha key', () => {
    expect(qk.customerGacha('cus_1')).toEqual([
      'admin',
      'customer',
      'cus_1',
      'gacha',
    ]);
  });
});
