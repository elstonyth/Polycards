import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GET, maskAccountNumber, parseStatusFilter } from '../route';
import { GET as REVEAL } from '../[id]/account/route';
import { GLOBEPAY_STALE_AFTER_MS } from '../../../../../modules/packs/globepay-reconcile';
import { WITHDRAWAL_STATUSES } from '../../../../../modules/packs/models/globepay-withdrawal';

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
  // Equal to created_at by default — a store-path row's updated_at IS its
  // created_at until something writes to it (plan 094's submit clock; same
  // convention as globepay-withdrawal-reconcile.unit.spec.ts's pendingRow).
  // Both columns are NOT NULL in the schema, and `stale` below now reads
  // this one.
  updated_at: new Date(Date.now() - 5 * 60 * 1000),
  settled_at: null,
  ...over,
});

// `frozenIds` seeds which customers listCustomerAccountStates reports as
// frozen — the list route's Task 6 addition (plan 094): the queue must surface
// the SAME flag the admin approve route refuses on, or an approver clicks into
// a refusal with no explanation.
//
// `frozenStateError`, when set, makes listCustomerAccountStates reject
// instead — the review-fix regression fixture for the route's .catch(() =>
// []) degrade (see the 'frozen-state lookup fails' test below).
function mkScope(
  rows: any[],
  frozenIds: string[] = [],
  frozenStateError?: Error,
) {
  const calls: { filter?: any; opts?: any; frozenFilter?: any } = {};
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const packs = {
    listAndCountGlobePayWithdrawals: async (filter: any, opts: any) => {
      calls.filter = filter;
      calls.opts = opts;
      const skip = opts?.skip ?? 0;
      return [rows.slice(skip, skip + (opts?.take ?? 50)), rows.length];
    },
    // Deliberately UNFILTERED on `frozen` (unlike the approve route's
    // single-id + frozen:true call) — this mock is the ONLY thing standing
    // between a wrong compound-filter assumption and a 500 on the real route,
    // so the route fetches every state for these ids and filters `frozen` in
    // JS instead of trusting an array-id + boolean filter to combine right.
    listCustomerAccountStates: async (filter: any) => {
      calls.frozenFilter = filter;
      if (frozenStateError) throw frozenStateError;
      const ids: string[] = Array.isArray(filter?.customer_id)
        ? filter.customer_id
        : [filter?.customer_id].filter(Boolean);
      return ids
        .filter((id) => frozenIds.includes(id))
        .map((id) => ({ id: `cas_${id}`, customer_id: id, frozen: true }));
    },
  };
  return {
    calls,
    logger,
    scope: {
      resolve: (key: string) => {
        if (key === 'logger') return logger;
        return typeof key === 'string' && key.toLowerCase().includes('customer')
          ? { listCustomers: async () => [{ id: 'cus_1', email: 'a@b.c' }] }
          : packs;
      },
    },
  };
}

describe('parseStatusFilter', () => {
  it('defaults to pending for anything unrecognized', () => {
    expect(parseStatusFilter(undefined)).toBe('pending');
    expect(parseStatusFilter('nonsense')).toBe('pending');
    expect(parseStatusFilter(['settled'])).toBe('pending');
  });

  it('accepts the five supported views', () => {
    for (const s of ['pending', 'settled', 'failed', 'held', 'all']) {
      expect(parseStatusFilter(s)).toBe(s);
    }
  });

  // The admin SPA's VIEWS array (apps/admin/src/routes/withdrawals/page.tsx)
  // is a FIFTH uncoordinated copy of this same status set, plus 'all'. It
  // can't be imported here: @acme/api's package.json `exports` map serves
  // only `./_generated` (see plans/041), and apps/admin is a separate SPA
  // package this project's tsconfig doesn't reach either. So this hand-lists
  // VIEWS' current contents and checks SET equality (never order — 'held'
  // is deliberately first as the operator default, VIEWS' own comment) against
  // WITHDRAWAL_STATUSES + 'all'. If either side drifts, update both in one PR.
  it('the admin SPA VIEWS set matches WITHDRAWAL_STATUSES + all (order not asserted)', () => {
    const adminViews = ['held', 'pending', 'settled', 'failed', 'all'];
    expect(new Set(adminViews)).toEqual(
      new Set([...WITHDRAWAL_STATUSES, 'all']),
    );
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

  // Task 6 (plan 094): approve refuses on a frozen account, so the queue must
  // show the SAME flag before the operator clicks — batched in ONE call
  // (never one listCustomerAccountStates per row, which would be an N+1 on a
  // 100-row page).
  it('carries the customer frozen state per row, fetched in one batched call', async () => {
    const { scope, calls } = mkScope(
      [
        withdrawal(1, { customer_id: 'cus_1' }),
        withdrawal(2, { customer_id: 'cus_2' }),
      ],
      ['cus_2'],
    );
    const { res, out } = mkRes();
    await GET({ scope, query: {} } as any, res);
    expect(out.body.withdrawals[0].frozen).toBe(false);
    expect(out.body.withdrawals[1].frozen).toBe(true);
    // ONE call naming both ids — not one lookup per row.
    expect(calls.frozenFilter).toEqual({ customer_id: ['cus_1', 'cus_2'] });
  });

  it('skips the frozen-state lookup when the page has no rows', async () => {
    const { scope, calls } = mkScope([]);
    const { res, out } = mkRes();
    await GET({ scope, query: {} } as any, res);
    expect(out.body.withdrawals).toEqual([]);
    expect(calls.frozenFilter).toBeUndefined();
  });

  // Review-fix regression: this lookup sits on the critical path of the
  // whole page, including the `pending` view operators use to find a
  // stranded debit. A failure here must degrade to `frozen: false` — exactly
  // pre-094 behaviour — not 500 the page. Nothing unsafe follows from the
  // degraded view: approve re-checks the freeze live before it acts.
  it('degrades to frozen:false for the whole page when the freeze lookup fails, rather than 500ing it', async () => {
    const { scope, logger } = mkScope(
      [withdrawal(1, { customer_id: 'cus_1' })],
      [],
      new Error('db timeout'),
    );
    const { res, out } = mkRes();
    await GET({ scope, query: {} } as any, res);
    expect(out.body.withdrawals[0].frozen).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain('db timeout');
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
      updated_at: new Date(Date.now() - GLOBEPAY_STALE_AFTER_MS - 60_000),
    });
    const { scope } = mkScope([old, withdrawal(2)]);
    const { res, out } = mkRes();
    await GET({ scope, query: { status: 'pending' } } as any, res);
    expect(out.body.withdrawals.map((w: any) => w.stale)).toEqual([
      true,
      false,
    ]);
  });

  // THE regression guard for plan 094's final review: stale must read the
  // SUBMIT clock (updated_at), not created_at. A held row approved and
  // submitted minutes ago carries a fresh updated_at but a created_at from
  // whenever the customer originally asked — possibly days earlier. Left on
  // created_at this row is flagged stale the instant it lands on the pending
  // view, the same sweep tick an approval would otherwise have resolved it.
  it('does not flag a just-approved row stale, however old the original request', async () => {
    const justApproved = withdrawal(1, {
      created_at: new Date(Date.now() - 6 * 60 * 60 * 1000),
      updated_at: new Date(Date.now() - 60 * 1000),
    });
    const { scope } = mkScope([justApproved]);
    const { res, out } = mkRes();
    await GET({ scope, query: { status: 'pending' } } as any, res);
    expect(out.body.withdrawals[0].stale).toBe(false);
  });

  it('never marks a settled row stale, however old', async () => {
    const { scope } = mkScope([
      withdrawal(1, {
        status: 'settled',
        created_at: new Date(Date.now() - 10 * GLOBEPAY_STALE_AFTER_MS),
        // AGED, not just created_at: `stale` reads updated_at, and the
        // factory default is a fresh 5-minutes-old value that is never
        // stale on its own. Without this, the test passed even with the
        // `status === 'pending'` gate deleted entirely — it was proving
        // "a fresh row isn't stale", not "a settled row isn't".
        updated_at: new Date(Date.now() - 10 * GLOBEPAY_STALE_AFTER_MS),
      }),
    ]);
    const { res, out } = mkRes();
    await GET({ scope, query: { status: 'settled' } } as any, res);
    expect(out.body.withdrawals[0].stale).toBe(false);
  });

  // held joins pending on the oldest-first side (Task 6, plan 094): the
  // longest-WAITING held row is the customer who has waited longest for a
  // human, the same reasoning as the longest-pending row being the likeliest
  // stranded debit — see the defaultDir comment in route.ts.
  it('pending and held sort oldest-first, other views newest-first, all drops the filter', async () => {
    const { scope, calls } = mkScope([withdrawal(1)]);
    const { res } = mkRes();
    await GET({ scope, query: { status: 'pending' } } as any, res);
    expect(calls.filter).toEqual({ status: 'pending' });
    // `id` tiebreaks the default path too — see the deposits spec.
    expect(calls.opts.order).toEqual({ created_at: 'ASC', id: 'ASC' });

    await GET({ scope, query: { status: 'held' } } as any, res);
    expect(calls.filter).toEqual({ status: 'held' });
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
