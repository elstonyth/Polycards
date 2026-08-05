import { GET, parseStatusFilter } from '../route';
import { GLOBEPAY_STALE_AFTER_MS } from '../../../../../modules/packs/globepay-reconcile';

// Money-OUT mirror of ../deposits — same contract, inverted stakes: a stale
// pending row here is a customer ALREADY debited with no payout and no refund.

const mkRes = () => {
  const out: { body?: any } = {};
  return {
    res: {
      json: (b: any) => {
        out.body = b;
      },
    } as any,
    out,
  };
};

const withdrawal = (i: number, over: Partial<Record<string, any>> = {}) => ({
  id: `gpw_${i}`,
  merchant_transaction_id: `PC-${i}`,
  gateway_transaction_id: `W20260805${i}`,
  customer_id: 'cus_1',
  // bigNumber columns hand back strings — the route must normalize them.
  amount: '50.00',
  bank_code: 'MBB',
  account_number: '1234567890',
  account_holder_name: 'Tan Ah Kow',
  status: 'pending',
  gateway_status: null,
  created_at: new Date(Date.now() - 5 * 60 * 1000),
  settled_at: null,
  ...over,
});

function mkScope(rows: any[]) {
  const calls: { filter?: any; opts?: any } = {};
  const packs = {
    listAndCountGlobePayWithdrawals: async (filter: any, opts: any) => {
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

describe('GET /admin/globepay/withdrawals', () => {
  it('normalizes bigNumber strings, joins the email, keeps the destination verbatim', async () => {
    const { scope } = mkScope([withdrawal(1)]);
    const { res, out } = mkRes();
    await GET({ scope, query: {} } as any, res);
    const row = out.body.withdrawals[0];
    expect(row.amount).toBe(50);
    expect(row.customer_email).toBe('a@b.c');
    // The destination is the dispute record — never truncated or masked here.
    expect(row.bank_code).toBe('MBB');
    expect(row.account_number).toBe('1234567890');
    expect(row.account_holder_name).toBe('Tan Ah Kow');
  });

  it('flags a pending row past the sweep window as stale, fresh ones not', async () => {
    const old = withdrawal(1, {
      created_at: new Date(Date.now() - GLOBEPAY_STALE_AFTER_MS - 60_000),
    });
    const { scope } = mkScope([old, withdrawal(2)]);
    const { res, out } = mkRes();
    await GET({ scope, query: { status: 'pending' } } as any, res);
    expect(out.body.withdrawals.map((w: any) => w.stale)).toEqual([
      true,
      false,
    ]);
  });

  it('never marks a settled row stale, however old', async () => {
    const { scope } = mkScope([
      withdrawal(1, {
        status: 'settled',
        created_at: new Date(Date.now() - 10 * GLOBEPAY_STALE_AFTER_MS),
      }),
    ]);
    const { res, out } = mkRes();
    await GET({ scope, query: { status: 'settled' } } as any, res);
    expect(out.body.withdrawals[0].stale).toBe(false);
  });

  it('pending sorts oldest-first, other views newest-first, all drops the filter', async () => {
    const { scope, calls } = mkScope([withdrawal(1)]);
    const { res } = mkRes();
    await GET({ scope, query: { status: 'pending' } } as any, res);
    expect(calls.filter).toEqual({ status: 'pending' });
    expect(calls.opts.order).toEqual({ created_at: 'ASC' });

    await GET({ scope, query: { status: 'all' } } as any, res);
    expect(calls.filter).toEqual({});
    expect(calls.opts.order).toEqual({ created_at: 'DESC' });
  });
});
