import { allocateStock, type AllocOrder } from '../stock-allocation';

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
