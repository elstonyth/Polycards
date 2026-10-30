import { GET, parseStatusFilter } from '../route';
import {
  GATEWAY_FULL_SWEEP_EVERY_MIN,
  GATEWAY_STALE_AFTER_MS,
} from '../../../../../modules/packs/gateway-reconcile';
import type {
  FakeFacet,
  GatewayReports,
} from '../../../../../modules/packs/facets';

const mkRes = () => {
  const out: { body?: any; status?: number } = {};
  return {
    res: {
      setHeader: () => {},
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
    listAndCountGatewayDeposits: async (filter: any, opts: any) => {
      calls.filter = filter;
      calls.opts = opts;
      const skip = opts?.skip ?? 0;
      return [rows.slice(skip, skip + (opts?.take ?? 50)), rows.length];
    },
  } satisfies FakeFacet<GatewayReports>;
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

describe('GET /admin/payments/deposits', () => {
  it('defaults to pending, oldest first — the stranded-payment view', async () => {
    const { res, out } = mkRes();
    const { scope, calls } = mkScope([deposit(1)]);
    await GET({ scope, query: {} } as any, res);

    expect(calls.filter).toEqual({ status: 'pending' });
    // `id` tiebreaks the DEFAULT path too — two deposits written in the same
    // tick share a created_at, and offset pagination needs a unique secondary
    // key or such a row lands on two pages / on neither.
    expect(calls.opts.order).toEqual({ created_at: 'ASC', id: 'ASC' });
    expect(out.body.status).toBe('pending');
  });

  it('drops the status filter for the "all" view and sorts newest first', async () => {
    const { res, out } = mkRes();
    const { scope, calls } = mkScope([deposit(1), deposit(2)]);
    await GET({ scope, query: { status: 'all' } } as any, res);

    expect(calls.filter).toEqual({});
    expect(calls.opts.order).toEqual({ created_at: 'DESC', id: 'DESC' });
    expect(out.body.total).toBe(2);
  });

  it('an explicit ?sort= overrides the status-dependent default, with id tiebreaker', async () => {
    const { res } = mkRes();
    const { scope, calls } = mkScope([deposit(1)]);
    await GET({ scope, query: { sort: 'amount_requested:asc' } } as any, res);

    expect(calls.opts.order).toEqual({ amount_requested: 'ASC', id: 'ASC' });
  });

  // No ?status= means the pending view, whose default is oldest-first. A
  // refused key must land on THAT default, not on a hardcoded newest-first —
  // otherwise a typo in the dashboard silently empties the top of the
  // stranded-payment work queue.
  it('an unknown sort key degrades to the view default, never a passthrough', async () => {
    const { res } = mkRes();
    const { scope, calls } = mkScope([deposit(1)]);
    await GET(
      { scope, query: { sort: 'customer_email; DROP TABLE x:desc' } } as any,
      res,
    );

    expect(calls.opts.order).toEqual({ created_at: 'ASC', id: 'ASC' });
  });

  it('a refused key on a history view keeps that view newest-first', async () => {
    const { res } = mkRes();
    const { scope, calls } = mkScope([deposit(1)]);
    await GET(
      { scope, query: { status: 'all', sort: 'customer_email:asc' } } as any,
      res,
    );

    expect(calls.opts.order).toEqual({ created_at: 'DESC', id: 'DESC' });
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
        created_at: new Date(Date.now() - GATEWAY_STALE_AFTER_MS - 60_000),
      }),
      deposit(2),
    ]);
    await GET({ scope, query: {} } as any, res);

    expect(out.body.deposits[0].stale).toBe(true);
    expect(out.body.deposits[1].stale).toBe(false);
  });

  // `stuck` = what the dashboard alarms on: pending two full sweeps past the
  // stale window WITH a gateway id. An abandoned cashier is expired by then;
  // a row with no gateway id never reached a cashier, so it cannot be paid.
  it('flags stuck only past two sweeps beyond the window, with a gateway id', async () => {
    const sweep = GATEWAY_FULL_SWEEP_EVERY_MIN * 60 * 1000;
    const ago = (ms: number) => new Date(Date.now() - GATEWAY_STALE_AFTER_MS - ms);
    const { res, out } = mkRes();
    const { scope } = mkScope([
      deposit(1, { created_at: ago(sweep) }),
      deposit(2, { created_at: ago(3 * sweep) }),
      deposit(3, { created_at: ago(3 * sweep), gateway_transaction_id: null }),
      deposit(4, {
        status: 'settled',
        amount_settled: '30.00',
        created_at: ago(30 * sweep),
      }),
    ]);
    await GET({ scope, query: { status: 'all' } } as any, res);

    expect(out.body.deposits.map((d: any) => d.stuck)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    // The broader `stale` still fires on the first one — that is the
    // abandoned-cashier window the dashboard no longer alarms on.
    expect(out.body.deposits[0].stale).toBe(true);
  });

  it('never flags a settled row, however old', async () => {
    const { res, out } = mkRes();
    const { scope } = mkScope([
      deposit(1, {
        status: 'settled',
        amount_settled: '30.00',
        created_at: new Date(Date.now() - 30 * GATEWAY_STALE_AFTER_MS),
      }),
    ]);
    await GET({ scope, query: { status: 'settled' } } as any, res);

    expect(out.body.deposits[0].stale).toBe(false);
  });

  it('honors offset/limit and rejects an absurd limit', async () => {
    const { res, out } = mkRes();
    const rows = Array.from({ length: 120 }, (_, i) => deposit(i));
    await GET(
      {
        scope: mkScope(rows).scope,
        query: { limit: '50', offset: '50' },
      } as any,
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

describe('GET /admin/payments/deposits ?customer_id (player page Payments tab)', () => {
  const CUS = 'cus_01M3WPN3TEN4H9NQRNS27MT4SQ';

  it('narrows the list to one customer, alongside the status filter', async () => {
    const { res } = mkRes();
    const { scope, calls } = mkScope([deposit(1)]);
    await GET({ scope, query: { status: 'all', customer_id: CUS } } as any, res);
    expect(calls.filter).toEqual({ customer_id: CUS });

    await GET({ scope, query: { status: 'failed', customer_id: CUS } } as any, mkRes().res);
    expect(calls.filter).toEqual({ status: 'failed', customer_id: CUS });
  });

  it('refuses a malformed customer_id instead of widening to every customer', async () => {
    const { res, out } = mkRes();
    const { scope, calls } = mkScope([deposit(1)]);
    for (const bad of ['', 'cus_x', "cus_' or 1=1", ['cus_01M3WPN3TEN4H9NQRNS27MT4SQ']]) {
      await GET({ scope, query: { customer_id: bad } } as any, res);
      expect(out.status).toBe(400);
    }
    expect(calls.filter).toBeUndefined();
  });
});
