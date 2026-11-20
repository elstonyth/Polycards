import { describe, expect, test } from 'vitest';
import { accountSkeletonKind } from '../AccountSkeleton';

// The (account) loading fallback picks its shape from the destination. The
// one trap: coin flip lives under /vault but is a game, not the vault grid.

describe('accountSkeletonKind', () => {
  test('each tab destination gets its own shape', () => {
    expect(accountSkeletonKind('/vault')).toBe('vault');
    expect(accountSkeletonKind('/vault/history')).toBe('vault-history');
    expect(accountSkeletonKind('/lucky-draw')).toBe('lucky-draw');
    expect(accountSkeletonKind('/me')).toBe('me');
  });

  test('coin flip is not the vault', () => {
    expect(accountSkeletonKind('/vault/coin-flip')).toBe('coin-flip');
    expect(accountSkeletonKind('/vault/coin-flip/x')).toBe('coin-flip');
  });

  test('every other account page gets the generic shape', () => {
    for (const path of [
      '/wallet',
      '/settings',
      '/orders',
      '/transactions',
      '/bank',
      '/bank-withdrawal',
      '/notifications',
      '/addresses',
      '/me/x',
      '/vaulted',
    ]) {
      expect(accountSkeletonKind(path)).toBe('generic');
    }
  });
});
