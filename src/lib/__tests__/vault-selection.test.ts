import { describe, expect, test } from 'vitest';
import { toggleSelectAll } from '@/lib/vault-selection';

describe('toggleSelectAll', () => {
  test('selects every visible id when none are selected', () => {
    const next = toggleSelectAll(new Set(), ['a', 'b', 'c']);
    expect([...next].sort()).toEqual(['a', 'b', 'c']);
  });

  test('unions visible ids with a hidden selection (persists across filters)', () => {
    // 'x' was selected under another rarity filter and is not visible now.
    const next = toggleSelectAll(new Set(['x']), ['a', 'b']);
    expect([...next].sort()).toEqual(['a', 'b', 'x']);
  });

  test('completes a partial visible selection instead of clearing it', () => {
    const next = toggleSelectAll(new Set(['a']), ['a', 'b', 'c']);
    expect([...next].sort()).toEqual(['a', 'b', 'c']);
  });

  test('deselects only the visible ids when all visible are selected', () => {
    const next = toggleSelectAll(new Set(['a', 'b', 'x']), ['a', 'b']);
    expect([...next]).toEqual(['x']);
  });

  test('is a no-op copy for an empty visible list', () => {
    const prev = new Set(['x']);
    const next = toggleSelectAll(prev, []);
    expect([...next]).toEqual(['x']);
    expect(next).not.toBe(prev); // always a fresh Set for React state
  });
});
