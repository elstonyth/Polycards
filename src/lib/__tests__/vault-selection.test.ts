import { describe, expect, test } from 'vitest';
import { sellTotals, toggleSelectAll } from '@/lib/vault-selection';
import { sellBackNotice } from '@/lib/buyback-copy';

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

describe('sellTotals', () => {
  test('a mixed selection holds only the bonus-paid part for packs', () => {
    // A gift-pack card and a task prize quote no held part; a pack paid one
    // fifth with bonus credit holds one fifth of its sale.
    const totals = sellTotals([
      { buyback: { amount: 20, bonus: 0 } },
      { buyback: { amount: 30, bonus: 0 } },
      { buyback: { amount: 30, bonus: 6 } },
    ]);
    expect(totals).toEqual({ amount: 80, held: 6 });
    expect(sellBackNotice(totals.amount, totals.held)).toBe(
      'RM 80.00 added — RM 6.00 of it for packs',
    );
  });

  test('nothing selected sells nothing', () => {
    expect(sellTotals([])).toEqual({ amount: 0, held: 0 });
  });
});
