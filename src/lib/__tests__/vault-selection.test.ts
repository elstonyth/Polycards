import { describe, expect, test } from 'vitest';
import {
  select,
  selectAllState,
  selectionSummary,
} from '@/lib/vault-selection';
import { sellBackNotice } from '@/lib/buyback-copy';

const NB = String.fromCharCode(0xa0);

type Row = {
  pullId: string;
  locked: boolean;
  sellable: boolean;
  card: { priceMyr: number | null };
  buyback: { amount: number; bonus: number };
};

const row = (pullId: string, over: Partial<Row> = {}): Row => ({
  pullId,
  locked: false,
  sellable: true,
  card: { priceMyr: 10 },
  buyback: { amount: 9, bonus: 0 },
  ...over,
});

const ids = (s: ReadonlySet<string>) => [...s].sort();

describe('select: toggle', () => {
  test('adds an unselected card and removes a selected one', () => {
    const items = [row('a'), row('b')];
    const once = select(new Set(), items, { type: 'toggle', pullId: 'a' });
    expect(ids(once)).toEqual(['a']);
    const twice = select(once, items, { type: 'toggle', pullId: 'a' });
    expect(ids(twice)).toEqual([]);
  });

  test('a locked card is never selected and the state is returned as is', () => {
    const items = [row('a', { locked: true })];
    const prev = new Set<string>();
    const next = select(prev, items, { type: 'toggle', pullId: 'a' });
    expect(next).toBe(prev); // same reference: React bails out of the render
  });

  test('always a fresh Set when it changes', () => {
    const prev = new Set(['x']);
    const next = select(prev, [row('a')], { type: 'toggle', pullId: 'a' });
    expect(next).not.toBe(prev);
    expect(ids(prev)).toEqual(['x']);
  });
});

describe('select: toggleAll (spec §3: visible cards only)', () => {
  test('selects every visible card when none are selected', () => {
    const visible = [row('a'), row('b'), row('c')];
    const next = select(new Set(), visible, { type: 'toggleAll' });
    expect(ids(next)).toEqual(['a', 'b', 'c']);
  });

  test('skips a locked visible card', () => {
    const visible = [row('a'), row('l', { locked: true }), row('b')];
    const next = select(new Set(), visible, { type: 'toggleAll' });
    expect(ids(next)).toEqual(['a', 'b']);
  });

  test('a locked card does not stop the visible set reading all-selected', () => {
    const visible = [row('a'), row('l', { locked: true })];
    const next = select(new Set(['a']), visible, { type: 'toggleAll' });
    expect(ids(next)).toEqual([]);
  });

  test('keeps a hidden selection (persists across filters)', () => {
    // 'x' was selected under another rarity filter and is not visible now.
    const visible = [row('a'), row('b')];
    const next = select(new Set(['x']), visible, { type: 'toggleAll' });
    expect(ids(next)).toEqual(['a', 'b', 'x']);
  });

  test('completes a partial visible selection instead of clearing it', () => {
    const visible = [row('a'), row('b'), row('c')];
    const next = select(new Set(['a']), visible, { type: 'toggleAll' });
    expect(ids(next)).toEqual(['a', 'b', 'c']);
  });

  test('deselects only the visible cards when all visible are selected', () => {
    const visible = [row('a'), row('b')];
    const next = select(new Set(['a', 'b', 'x']), visible, {
      type: 'toggleAll',
    });
    expect(ids(next)).toEqual(['x']);
  });

  test('a fresh copy for an empty or all-locked visible list', () => {
    const prev = new Set(['x']);
    for (const visible of [[], [row('l', { locked: true })]]) {
      const next = select(prev, visible, { type: 'toggleAll' });
      expect(ids(next)).toEqual(['x']);
      expect(next).not.toBe(prev);
    }
  });
});

describe('selectAllState', () => {
  test('counts only selectable visible cards', () => {
    const visible = [row('a'), row('l', { locked: true }), row('b')];
    expect(selectAllState(new Set(['a']), visible)).toEqual({
      count: 2,
      allSelected: false,
    });
    expect(selectAllState(new Set(['a', 'b']), visible)).toEqual({
      count: 2,
      allSelected: true,
    });
  });

  test('nothing selectable is never all-selected', () => {
    expect(selectAllState(new Set(), [row('l', { locked: true })])).toEqual({
      count: 0,
      allSelected: false,
    });
  });
});

describe('selectionSummary', () => {
  test('a locked id in the selection is left out of every total', () => {
    const items = [row('a'), row('l', { locked: true })];
    const s = selectionSummary(new Set(['a', 'l']), items);
    expect(s.items.map((i) => i.pullId)).toEqual(['a']);
    expect(s.sellable.map((i) => i.pullId)).toEqual(['a']);
    expect(s.fmv).toBe(10);
  });

  test('sell math runs over the sellable subset only', () => {
    const items = [
      row('a'),
      row('u', { sellable: false, card: { priceMyr: 50 } }),
    ];
    const s = selectionSummary(new Set(['a', 'u']), items);
    expect(s.items.map((i) => i.pullId)).toEqual(['a', 'u']);
    expect(s.fmv).toBe(60);
    expect(s.sellable.map((i) => i.pullId)).toEqual(['a']);
    expect(s.sellableFmv).toBe(10);
    expect(s.amount).toBe(9);
  });

  test('an unpriced card counts as 0', () => {
    const s = selectionSummary(new Set(['a']), [
      row('a', { card: { priceMyr: null } }),
    ]);
    expect(s.fmv).toBe(0);
    expect(s.sellableFmv).toBe(0);
  });

  test('a mixed selection holds only the bonus-paid part for packs', () => {
    // A gift-pack card and a task prize quote no held part; a pack paid one
    // fifth with bonus credit holds one fifth of its sale.
    const items = [
      row('g', { buyback: { amount: 20, bonus: 0 } }),
      row('t', { buyback: { amount: 30, bonus: 0 } }),
      row('p', { buyback: { amount: 30, bonus: 6 } }),
    ];
    const s = selectionSummary(new Set(['g', 't', 'p']), items);
    expect({ amount: s.amount, held: s.held }).toEqual({ amount: 80, held: 6 });
    expect(sellBackNotice(s.amount, s.held)).toBe(
      `RM${NB}80.00 added — RM${NB}6.00 of it for packs`,
    );
  });

  test('nothing selected sells nothing', () => {
    const s = selectionSummary(new Set(), [row('a')]);
    expect(s).toEqual({
      items: [],
      sellable: [],
      fmv: 0,
      sellableFmv: 0,
      amount: 0,
      held: 0,
    });
  });
});
