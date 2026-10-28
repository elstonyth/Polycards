import { describe, expect, it } from 'vitest';
import { keepPreviousWhenSame } from './keep-previous';

const query = (key: readonly unknown[]) => ({ queryKey: key }) as never;

describe('keepPreviousWhenSame', () => {
  const page2 = ['admin', 'customer', 'c1', 'transactions', 2, 'all'];

  it('keeps the last page while paging within the same filter', () => {
    const keep = keepPreviousWhenSame(page2, 5);
    const prev = { items: [1] };
    expect(
      keep(prev, query(['admin', 'customer', 'c1', 'transactions', 1, 'all'])),
    ).toBe(prev);
  });

  // A filter change must not show the old filter's rows under the new one.
  it('drops it when the filter segment changed', () => {
    const keep = keepPreviousWhenSame(
      ['admin', 'customer', 'c1', 'transactions', 0, 'pack_open'],
      5,
    );
    expect(
      keep(
        { items: [1] },
        query(['admin', 'customer', 'c1', 'transactions', 3, 'all']),
      ),
    ).toBeUndefined();
  });

  it('drops it for another customer, and with nothing to keep', () => {
    const keep = keepPreviousWhenSame(page2, 5);
    expect(
      keep(
        { items: [1] },
        query(['admin', 'customer', 'c2', 'transactions', 1, 'all']),
      ),
    ).toBeUndefined();
    expect(keep(undefined, undefined)).toBeUndefined();
  });

  it('compares every segment from the filter on (status and sort)', () => {
    const keep = keepPreviousWhenSame(
      ['admin', 'customer', 'c1', 'pulls', 1, 'vaulted', 'value'],
      5,
    );
    const prev = { items: [] };
    expect(
      keep(
        prev,
        query(['admin', 'customer', 'c1', 'pulls', 0, 'vaulted', 'value']),
      ),
    ).toBe(prev);
    expect(
      keep(
        prev,
        query(['admin', 'customer', 'c1', 'pulls', 0, 'vaulted', 'newest']),
      ),
    ).toBeUndefined();
  });
});
