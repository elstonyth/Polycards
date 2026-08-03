import { GET, parseStatusFilter } from '../route';
import { GLOBEPAY_STALE_AFTER_MS } from '../../../../../modules/packs/globepay-reconcile';

const mkRes = () => {
  const out: { body?: any; status?: number } = {};
  return {
    res: {
      json: (b: any) => {
        out.body = b;
      },
      status: (s: number) => {
        out.status = s;
        return { json: (b: any) => (out.body = b) };
      },
    } as any,
    out,
  };
};

const deposit = (i: number, over: Partial<Record<string, any>> = {}) => ({
  id: `gpd_${i}`,
  merchant_transaction_id: `PC-${i}`,
  gateway_transaction_id: `D20260722${i}`,
  customer_id: 'cus_1',
  // bigNumber columns hand back strings — the route must normalize them.
  amount_requested: '30.00',
  amount_settled: null,
  payment_method_code: 'BQR',
  status: 'pending',
  gateway_status: null,
  created_at: new Date(Date.now() - 5 * 60 * 1000),
  settled_at: null,
  ...over,
});

function mkScope(rows: any[]) {
  const calls: { filter?: any; opts?: any } = {};
  const packs = {
    listAndCountGlobePayDeposits: async (filter: any, opts: any) => {
      calls.filter = filter;
      calls.opts = opts;
      const skip = opts?.skip ?? 0;
      return [rows.slice(skip, skip + (opts?.take ?? 50)), rows.length];
    },
  };
  return {
    calls,
    scope: {
      resolve: (key: string) =>
        typeof key === 'string' && key.toLowerCase().includes('customer')
          ? { listCustomers: async () => [{ id: 'cus_1', email: 'a@b.c' }] }
          : packs,
    },
  };
}

describe('parseStatusFilter', () => {
  it('defaults to pending for anything unrecognized', () => {
    expect(parseStatusFilter(undefined)).toBe('pending');
    expect(parseStatusFilter('nonsense')).toBe('pending');
    expect(parseStatusFilter(['settled'])).toBe('pending');
  });

  it('accepts the four supported views', () => {
    for (const s of ['pending', 'settled', 'failed', 'all']) {
      expect(parseStatusFilter(s)).toBe(s);
    }
  });
});

describe('GET /admin/globepay/deposits', () => {
  it('defaults to pending, oldest first — the stranded-payment view', async () => {
    const { res, out } = mkRes();
    const { scope, calls } = mkScope([deposit(1)]);
    await GET({ scope, query: {} } as any, res);

    expect(calls.filter).toEqual({ status: 'pending' });
    expect(calls.opts.order).toEqual({ created_at: 'ASC' });
    expect(out.body.status).toBe('pending');
  });

  it('drops the status filter for the "all" view and sorts newest first', async () => {
    const { res, out } = mkRes();
    const { scope, calls } = mkScope([deposit(1), deposit(2)]);
    await GET({ scope, query: { status: 'all' } } as any, res);

    expect(calls.filter).toEqual({});
    expect(calls.opts.order).toEqual({ created_at: 'DESC' });
    expect(out.body.total).toBe(2);
  });

  it('joins the customer email and normalizes bigNumber amounts', async () => {
    const { res, out } = mkRes();
    const { scope } = mkScope([
      deposit(1, { status: 'settled', amount_settled: '50.00' }),
    ]);
    await GET({ scope, query: { status: 'settled' } } as any, res);

    const row = out.body.deposits[0];
    expect(row.customer_email).toBe('a@b.c');
    expect(row.amount_requested).toBe(30);
    expect(row.amount_settled).toBe(50);
  });

  it('flags a pending row older than the sweep window as stale', async () => {
    const { res, out } = mkRes();
    const { scope } = mkScope([
      deposit(1, {
        created_at: new Date(Date.now() - GLOBEPAY_STALE_AFTER_MS - 60_000),
      }),
      deposit(2),
    ]);
    await GET({ scope, query: {} } as any, res);

    expect(out.body.deposits[0].stale).toBe(true);
    expect(out.body.deposits[1].stale).toBe(false);
  });

  it('never flags a settled row, however old', async () => {
    const { res, out } = mkRes();
    const { scope } = mkScope([
      deposit(1, {
        status: 'settled',
        amount_settled: '30.00',
        created_at: new Date(Date.now() - 30 * GLOBEPAY_STALE_AFTER_MS),
      }),
    ]);
    await GET({ scope, query: { status: 'settled' } } as any, res);

    expect(out.body.deposits[0].stale).toBe(false);
  });

  it('honors offset/limit and rejects an absurd limit', async () => {
    const { res, out } = mkRes();
    const rows = Array.from({ length: 120 }, (_, i) => deposit(i));
    await GET(
      { scope: mkScope(rows).scope, query: { limit: '50', offset: '50' } } as any,
      res,
    );
    expect(out.body.total).toBe(120);
    expect(out.body.offset).toBe(50);
    expect(out.body.deposits).toHaveLength(50);

    await expect(
      GET({ scope: mkScope(rows).scope, query: { limit: '500' } } as any, res),
    ).rejects.toThrow(/limit/);
  });
});
