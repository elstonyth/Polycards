import { describe, expect, it } from 'vitest';
import { coverItems } from './stock-cover';
import type { AdminDeliveryItem } from '../../lib/admin-rest';

const item = (pull_id: string, handle: string | null): AdminDeliveryItem => ({
  pull_id,
  card: handle ? { handle, name: handle, image: '', slab_image: null } : null,
});

describe('coverItems', () => {
  it('marks covered items in stock and the rest missing', () => {
    const r = coverItems(
      [item('p1', 'a'), item('p2', 'b')],
      [
        { handle: 'a', need: 1, have: 1, on_hand: 1 },
        { handle: 'b', need: 1, have: 0, on_hand: 0 },
      ],
    );
    expect(r.inStock).toBe(1);
    expect(r.missing).toBe(1);
    expect(r.byPull.get('p1')).toEqual({ inStock: true, keptForOthers: false });
    expect(r.byPull.get('p2')).toEqual({
      inStock: false,
      keptForOthers: false,
    });
  });

  it('splits a card wanted twice: first copy in stock, second missing', () => {
    const r = coverItems(
      [item('p1', 'a'), item('p2', 'a')],
      [{ handle: 'a', need: 2, have: 1, on_hand: 1 }],
    );
    expect(r.byPull.get('p1')?.inStock).toBe(true);
    expect(r.byPull.get('p2')).toEqual({
      inStock: false,
      keptForOthers: false,
    });
  });

  it('flags a missing card that is on the shelf for other orders', () => {
    const r = coverItems(
      [item('p1', 'a')],
      [{ handle: 'a', need: 1, have: 0, on_hand: 2 }],
    );
    expect(r.byPull.get('p1')).toEqual({ inStock: false, keptForOthers: true });
  });

  it('leaves an item with no card row unmarked', () => {
    const r = coverItems(
      [item('p1', null)],
      [{ handle: 'a', need: 1, have: 1, on_hand: 1 }],
    );
    expect(r.byPull.size).toBe(0);
    expect(r.inStock + r.missing).toBe(0);
  });
});
