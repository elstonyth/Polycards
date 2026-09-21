import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGroupCreditAdjustment,
  loadGroupCreditCustomers,
  parseGroupCreditAmount,
  runGroupCreditAdjustment,
} from './group-credit-edit';
import type { GroupCreditCustomer } from './admin-rest';

afterEach(() => vi.unstubAllGlobals());

const customer = (index: number): GroupCreditCustomer => ({
  id: `cus_${index}`,
  email: `player${index}@example.com`,
  first_name: `Player ${index}`,
  last_name: null,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe('group credit editing', () => {
  it('loads every member across pages, with a stable order and group filter', async () => {
    vi.stubGlobal('__BACKEND_URL__', 'http://backend.test');
    const customers = Array.from({ length: 215 }, (_, index) =>
      customer(index),
    );
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input);
      expect(url.pathname).toBe('/admin/customers');
      expect(url.searchParams.get('groups')).toBe('cg_partner & special');
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.get('order')).toBe('id');
      const offset = Number(url.searchParams.get('offset'));
      return json({
        customers: customers.slice(offset, offset + 100),
        count: customers.length,
      });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(await loadGroupCreditCustomers('cg_partner & special')).toEqual(
      customers,
    );
    expect(
      fetcher.mock.calls.map(([url]) =>
        new URL(url).searchParams.get('offset'),
      ),
    ).toEqual(['0', '100', '200']);
  });

  it('refuses a truncated group instead of exposing a partial all-player selection', async () => {
    vi.stubGlobal('__BACKEND_URL__', 'http://backend.test');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ customers: [customer(1)], count: 2 }))
        .mockResolvedValueOnce(json({ customers: [], count: 2 })),
    );
    await expect(loadGroupCreditCustomers('cg_partner')).rejects.toThrow(
      /reload/i,
    );
  });

  it('accepts nonzero signed cents within the backend limit', () => {
    for (const valid of ['100', '-0.01', '+12.50', '0.29', '1000000']) {
      expect(parseGroupCreditAmount(valid)).toBe(Number(valid));
    }
    for (const invalid of [
      '',
      '0',
      '-0',
      '1.001',
      '1e3',
      'Infinity',
      '1000000.01',
      '-1000000.01',
    ]) {
      expect(parseGroupCreditAmount(invalid)).toBeNull();
    }
    const customers = [customer(1)];
    expect(
      createGroupCreditAdjustment(customers, new Set(), '5', 'Audit'),
    ).toBeNull();
    expect(
      createGroupCreditAdjustment(customers, new Set(['cus_1']), '5', '  '),
    ).toBeNull();
    expect(
      createGroupCreditAdjustment(
        customers,
        new Set(['cus_1']),
        '5',
        'x'.repeat(513),
      ),
    ).toBeNull();
  });

  it('snapshots a selected subset and retries failures using original keys without repeating successes', async () => {
    vi.stubGlobal('__BACKEND_URL__', 'http://backend.test');
    const customers = [customer(1), customer(2), customer(3)];
    const selected = new Set(['cus_1', 'cus_3', 'not-a-group-member']);
    const batch = createGroupCreditAdjustment(
      customers,
      selected,
      '-12.50',
      ' Partner adjustment ',
    );
    expect(batch).not.toBeNull();
    if (!batch) throw new Error('Expected valid batch');
    selected.clear();
    customers[0].email = 'changed@example.com';
    expect(batch.customers.map((row) => row.id)).toEqual(['cus_1', 'cus_3']);
    expect(batch.customers[0].email).toBe('player1@example.com');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ amount: -12.5, balance: 87.5 }))
      .mockRejectedValueOnce(new Error('Response lost'))
      .mockResolvedValueOnce(json({ amount: -12.5, balance: 87.5 }));
    vi.stubGlobal('fetch', fetcher);
    const progress = vi.fn();
    const first = await runGroupCreditAdjustment(batch, {}, progress);
    expect(first.cus_1).toEqual({ status: 'succeeded', balance: 87.5 });
    expect(first.cus_3).toEqual({ status: 'failed', message: 'Response lost' });
    const retried = await runGroupCreditAdjustment(batch, first, progress);
    expect(retried.cus_3.status).toBe('succeeded');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://backend.test/admin/customers/cus_1/credits',
      'http://backend.test/admin/customers/cus_3/credits',
      'http://backend.test/admin/customers/cus_3/credits',
    ]);
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[2]).toEqual({
      amount: -12.5,
      note: 'Partner adjustment',
      idempotency_key: `${batch.id}:cus_3`,
    });
    await runGroupCreditAdjustment(batch, retried, progress);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenCalledTimes(3);
  });
});
