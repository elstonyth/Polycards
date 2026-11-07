import {
  allocateStock,
  stockCoverFor,
  type AllocOrder,
} from '../stock-allocation';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 28, 0, minute));
const order = (
  id: string,
  minute: number,
  handles: string[],
  status = 'requested',
): AllocOrder => ({ id, status, created_at: at(minute), handles });
const stock = (entries: Record<string, number>) =>
  new Map(Object.entries(entries));

describe('allocateStock (strict oldest-first, spec 2026-10-28)', () => {
  it('gives a single unit to the oldest order', () => {
    const r = allocateStock(stock({ a: 1 }), [
      order('new', 5, ['a']),
      order('old', 1, ['a']),
    ]);
    expect(r).toEqual({ ready: ['old'], short: ['new'] });
  });

  it('lets a partially covered old order hold its units against newer orders for the same card', () => {
    // old needs a+b, only a is in: it holds a, so new (a only) must wait.
    const r = allocateStock(stock({ a: 1 }), [
      order('old', 1, ['a', 'b']),
      order('new', 2, ['a']),
    ]);
    expect(r).toEqual({ ready: [], short: ['old', 'new'] });
  });

  it('does not block a newer order for a different card', () => {
    const r = allocateStock(stock({ a: 1, c: 1 }), [
      order('old', 1, ['a', 'b']),
      order('other', 2, ['c']),
    ]);
    expect(r).toEqual({ ready: ['other'], short: ['old'] });
  });

  it('counts every unit: two of the same card need two', () => {
    expect(allocateStock(stock({ a: 1 }), [order('o', 1, ['a', 'a'])])).toEqual(
      { ready: [], short: ['o'] },
    );
    expect(allocateStock(stock({ a: 2 }), [order('o', 1, ['a', 'a'])])).toEqual(
      { ready: ['o'], short: [] },
    );
  });

  it('lets ready_to_ship orders keep their units first', () => {
    const r = allocateStock(stock({ a: 1 }), [
      order('waiting', 1, ['a']),
      order('held', 9, ['a'], 'ready_to_ship'),
    ]);
    expect(r).toEqual({ ready: [], short: ['waiting'] });
  });

  it('ignores canceled, shipped and completed orders', () => {
    const r = allocateStock(stock({ a: 1 }), [
      order('gone', 0, ['a'], 'canceled'),
      order('sent', 0, ['a'], 'shipped'),
      order('done', 0, ['a'], 'completed'),
      order('live', 3, ['a']),
    ]);
    expect(r).toEqual({ ready: ['live'], short: [] });
  });

  it('allocates processed and legacy packing orders like requested ones', () => {
    const r = allocateStock(stock({ a: 2 }), [
      order('p', 1, ['a'], 'processed'),
      order('k', 2, ['a'], 'packing'),
    ]);
    expect(r).toEqual({ ready: ['p', 'k'], short: [] });
  });

  it('treats negative or missing on hand as nothing free', () => {
    const r = allocateStock(stock({ a: -3 }), [
      order('neg', 1, ['a']),
      order('missing', 2, ['zzz']),
    ]);
    expect(r).toEqual({ ready: [], short: ['neg', 'missing'] });
  });

  it('breaks a created_at tie by id so reruns agree', () => {
    const r = allocateStock(stock({ a: 1 }), [
      order('b-order', 1, ['a']),
      order('a-order', 1, ['a']),
    ]);
    expect(r).toEqual({ ready: ['a-order'], short: ['b-order'] });
  });
});

describe('stockCoverFor (Orders page: which cards are in, which are missing)', () => {
  it('shows an old order holding the unit it got and missing the rest', () => {
    const orders = [order('old', 1, ['a', 'b'], 'processed')];
    expect(stockCoverFor('old', stock({ a: 1 }), orders)).toEqual([
      { handle: 'a', need: 1, have: 1, on_hand: 1 },
      { handle: 'b', need: 1, have: 0, on_hand: 0 },
    ]);
  });

  it('counts the same card twice: one unit in, one missing', () => {
    const orders = [order('o', 1, ['a', 'a'], 'processed')];
    expect(stockCoverFor('o', stock({ a: 1 }), orders)).toEqual([
      { handle: 'a', need: 2, have: 1, on_hand: 1 },
    ]);
  });

  it('shows a newer order missing a card that is on the shelf for an older one', () => {
    const orders = [
      order('old', 1, ['a']),
      order('new', 2, ['a'], 'processed'),
    ];
    expect(stockCoverFor('new', stock({ a: 1 }), orders)).toEqual([
      { handle: 'a', need: 1, have: 0, on_hand: 1 },
    ]);
    expect(stockCoverFor('old', stock({ a: 1 }), orders)).toEqual([
      { handle: 'a', need: 1, have: 1, on_hand: 1 },
    ]);
  });

  it('gives a ready_to_ship order every unit, ahead of older open orders', () => {
    const orders = [
      order('waiting', 1, ['a']),
      order('held', 9, ['a'], 'ready_to_ship'),
    ];
    expect(stockCoverFor('held', stock({ a: 1 }), orders)).toEqual([
      { handle: 'a', need: 1, have: 1, on_hand: 1 },
    ]);
    expect(stockCoverFor('waiting', stock({ a: 1 }), orders)).toEqual([
      { handle: 'a', need: 1, have: 0, on_hand: 1 },
    ]);
  });

  it('reports negative on hand as 0', () => {
    expect(
      stockCoverFor('o', stock({ a: -2 }), [order('o', 1, ['a'])]),
    ).toEqual([{ handle: 'a', need: 1, have: 0, on_hand: 0 }]);
  });

  it('returns null for an order that is not waiting on stock', () => {
    const orders = [order('sent', 1, ['a'], 'shipped')];
    expect(stockCoverFor('sent', stock({ a: 1 }), orders)).toBeNull();
    expect(stockCoverFor('nope', stock({ a: 1 }), orders)).toBeNull();
  });

  it('agrees with allocateStock: a ready order has every unit, a short one does not', () => {
    const onHand = stock({ a: 2, b: 1 });
    const orders = [
      order('o1', 1, ['a', 'b']),
      order('o2', 2, ['a', 'b'], 'processed'),
      order('o3', 3, ['a']),
    ];
    const { ready, short } = allocateStock(onHand, orders);
    const full = (id: string) =>
      stockCoverFor(id, onHand, orders)!.every((c) => c.have === c.need);
    expect(ready.every(full)).toBe(true);
    expect(short.some(full)).toBe(false);
  });
});
