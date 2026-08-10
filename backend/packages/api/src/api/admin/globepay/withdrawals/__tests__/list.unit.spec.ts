import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GET, maskAccountNumber, parseStatusFilter } from '../route';
import { GET as REVEAL } from '../[id]/account/route';
import { GLOBEPAY_STALE_AFTER_MS } from '../../../../../modules/packs/globepay-reconcile';

// Money-OUT mirror of ../deposits — same contract, inverted stakes: a stale
// pending row here is a customer ALREADY debited with no payout and no refund.

const mkRes = () => {
  const out: { body?: any; headers: Record<string, string> } = { headers: {} };
  return {
    res: {
      setHeader: (k: string, v: string) => {
        out.headers[k] = v;
      },
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
  it('normalizes bigNumber strings, joins the email, masks the destination account', async () => {
    const { scope } = mkScope([withdrawal(1)]);
    const { res, out } = mkRes();
    await GET({ scope, query: {} } as any, res);
    const row = out.body.withdrawals[0];
    expect(row.amount).toBe(50);
    expect(row.customer_email).toBe('a@b.c');
    expect(row.bank_code).toBe('MBB');
    // THE regression guard: this list serves up to 100 rows per request, so a
    // full account number here hands out every listed customer's bank details
    // for one row's worth of operator need. Full value = ./[id]/account only.
    expect(row.account_number).not.toBe('1234567890');
    expect(row.account_number).toBe('••••7890');
    // The last 4 must survive — an operator matches a row to a dispute by it.
    expect(row.account_number).toContain('7890');
    // NOT masked: the other half of the same match. Masking it would overreach
    // and push the lookup somewhere unaudited.
    expect(row.account_holder_name).toBe('Tan Ah Kow');
    // Identity-varying (emails) — must never be cacheable (CWE-524).
    expect(out.headers['Cache-Control']).toBe('no-store');
  });

  // The mask agrees with setPayoutDetails' audit-row last4 (service.ts): digits
  // only, and only when there are MORE than four of them — for a <=4-digit
  // account the "last 4" IS the whole number, which is what must not leak.
  it('masks formatting characters and refuses to reveal a short account whole', () => {
    expect(maskAccountNumber('1234-5678 90')).toBe('••••7890');
    expect(maskAccountNumber('12345')).toBe('••••2345');
    expect(maskAccountNumber('1234')).toBe('••••');
    expect(maskAccountNumber('')).toBe('••••');
    expect(maskAccountNumber(null)).toBe('••••');
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
    // `id` tiebreaks the default path too — see the deposits spec.
    expect(calls.opts.order).toEqual({ created_at: 'ASC', id: 'ASC' });

    await GET({ scope, query: { status: 'all' } } as any, res);
    expect(calls.filter).toEqual({});
    expect(calls.opts.order).toEqual({ created_at: 'DESC', id: 'DESC' });
  });

  it('an explicit ?sort= overrides the status-dependent default, with id tiebreaker', async () => {
    const { scope, calls } = mkScope([withdrawal(1)]);
    const { res } = mkRes();
    await GET({ scope, query: { sort: 'amount:asc' } } as any, res);
    expect(calls.opts.order).toEqual({ amount: 'ASC', id: 'ASC' });
  });

  // account_number is deliberately NOT allowlisted — it is a masked display
  // string here, not a sort axis (and sorting by it would order rows by the
  // very digits the mask withholds). A refused key falls back to the VIEW's
  // default (pending = oldest-first here), same as deposits.
  it('an unknown sort key degrades to the view default, never a passthrough', async () => {
    const { scope, calls } = mkScope([withdrawal(1)]);
    const { res } = mkRes();
    await GET({ scope, query: { sort: 'account_number:desc' } } as any, res);
    expect(calls.opts.order).toEqual({ created_at: 'ASC', id: 'ASC' });

    await GET(
      { scope, query: { status: 'all', sort: 'account_number:asc' } } as any,
      res,
    );
    expect(calls.opts.order).toEqual({ created_at: 'DESC', id: 'DESC' });
  });
});

// The other half of the masking: without a reveal path an operator chasing a
// disputed payout goes to the database console, where nothing is logged and
// nothing is rate-limited.
describe('GET /admin/globepay/withdrawals/:id/account', () => {
  const mkRevealScope = (rows: any[]) => {
    const calls: { filter?: any; opts?: any } = {};
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const packs = {
      listGlobePayWithdrawals: async (filter: any, opts: any) => {
        calls.filter = filter;
        calls.opts = opts;
        return rows;
      },
    };
    return {
      calls,
      logger,
      scope: { resolve: (k: string) => (k === 'logger' ? logger : packs) },
    };
  };

  const mkReq = (scope: any, id: string) => ({
    scope,
    params: { id },
    auth_context: { actor_id: 'usr_admin_1' },
  });

  it('returns the FULL number for one id, uncacheable', async () => {
    const { scope, calls } = mkRevealScope([withdrawal(1)]);
    const { res, out } = mkRes();
    await REVEAL(mkReq(scope, 'gpw_1') as any, res);
    expect(out.body).toEqual({ id: 'gpw_1', account_number: '1234567890' });
    // Single row per request, selected by id — no bulk variant exists, and the
    // take:1 means a filter bug cannot turn this into a table dump.
    expect(calls.filter).toEqual({ id: 'gpw_1' });
    expect(calls.opts).toEqual({ take: 1 });
    expect(out.headers['Cache-Control']).toBe('no-store');
  });

  it('logs the reveal with the row and the actor, and NEVER the number', async () => {
    const { scope, logger } = mkRevealScope([withdrawal(1)]);
    const { res } = mkRes();
    await REVEAL(mkReq(scope, 'gpw_1') as any, res);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0][0] as string;
    expect(line).toContain('gpw_1');
    expect(line).toContain('usr_admin_1');
    // Boolean, not .not.toContain(): a failing toContain prints the whole
    // logged string — i.e. the account number this assertion exists to keep
    // out of logs — into a public CI log.
    expect(line.includes('1234567890')).toBe(false);
  });

  it('404s an unknown id WITHOUT logging a reveal that never happened', async () => {
    const { scope, logger } = mkRevealScope([]);
    const { res } = mkRes();
    await expect(REVEAL(mkReq(scope, 'gpw_nope') as any, res)).rejects.toThrow(
      /not found/i,
    );
    expect(logger.info.mock.calls.length).toBe(0);
  });

  // Auth is NOT exercised here: this spec calls the handler directly, so there
  // is no router and no middleware chain. The route is protected by the
  // framework's blanket `/admin` guard (registered in router.js before any
  // matcher in src/api/middlewares.ts), exactly like every sibling admin route
  // in this directory — none of which test auth either. What this spec CAN
  // pin is the rate-limit registration, which is ours and is easy to drop.
  // Source-text, not an import: middlewares.ts constructs its rate limiters at
  // module load (Redis connections), which a unit spec must not do.
  it('is registered on the admin action rate limiter', () => {
    const middlewares = readFileSync(
      join(__dirname, '../../../../middlewares.ts'),
      'utf8',
    );
    // The whole entry, not just the matcher string: a matcher registered
    // without adminActionRateLimit would leave the reveal unthrottled, which is
    // the failure this guards.
    expect(middlewares).toMatch(
      /matcher: '\/admin\/globepay\/withdrawals\/\*\/account',\s*method: 'GET',\s*middlewares: \[adminActionRateLimit\]/,
    );
  });
});
