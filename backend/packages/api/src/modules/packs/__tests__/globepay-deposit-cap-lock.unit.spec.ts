import PacksModuleService from '../service';

/**
 * createGlobePayDepositCapped — the per-customer pending-deposit cap
 * (GLOBEPAY_MAX_RECENT_PENDING_PER_CUSTOMER) is counted and inserted inside ONE
 * customer-locked transaction (#429).
 *
 * WHY THIS FILE EXISTS: the module-level cap tests in globepay-deposit.unit.spec
 * pass with or without the lock — they stub the service seam entirely, so they
 * pin the POLICY (refuse at the cap, refuse before the gateway call) and nothing
 * about atomicity. Delete the pg_advisory_xact_lock line here, or drop
 * `sharedContext` from the count, and every one of those stays green while the
 * cap goes back to being advisory.
 *
 * HONESTY NOTE ON COVERAGE: a jest unit test with no database cannot run two
 * real transactions against one Postgres advisory lock, so nothing below proves
 * the burst race is closed. What is pinned is the ORDERING and the SCOPE that
 * make closing it possible — lock first, on a per-customer key, count after it
 * ON THE LOCKED CONTEXT, and no insert at all once the count is at the cap.
 * Same fake-`this` technique as credit-adjust-lock.unit.spec.ts.
 */

const fakeService = (recentPending = 0) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const ops: string[] = [];
  const em = {
    execute: jest.fn(async (query: string, _params?: unknown[]) => {
      ops.push(query.includes('pg_advisory_xact_lock') ? 'lock' : 'sql');
      return [];
    }),
  };
  // Own properties shadow the decorated prototype methods — this file is about
  // the order and the context they are called WITH, not what they do.
  const calls = {
    listAndCountGlobePayDeposits: jest.fn(
      async (_filter: unknown, _config: unknown, _ctx: unknown) => {
        ops.push('count');
        return [[], recentPending] as [unknown[], number];
      },
    ),
    createGlobePayDeposits: jest.fn(async (_data: unknown, _ctx: unknown) => {
      ops.push('insert');
      return [{ id: 'gpd_1' }];
    }),
  };
  Object.assign(svc, calls);
  return {
    svc,
    em,
    ops,
    calls,
    ctx: { transactionManager: em, manager: em } as never,
  };
};

const input = {
  data: {
    merchant_transaction_id: 'PC-abc',
    customer_id: 'cus_1',
    amount_requested: 50,
    payment_method_code: 'BQR',
    status: 'pending' as const,
  },
  maxRecentPending: 5,
  windowMs: 20 * 60 * 1000,
};

describe('PacksModuleService.createGlobePayDepositCapped', () => {
  it('locks per customer BEFORE counting, then inserts', async () => {
    const f = fakeService(0);
    const row = await f.svc.createGlobePayDepositCapped(input, f.ctx);

    expect(row).toEqual({ id: 'gpd_1' });
    expect(f.ops).toEqual(['lock', 'count', 'insert']);
    expect(f.em.execute.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    // Per-customer key, NOT the `credit:<id>` one: this is a queue-fairness
    // invariant, and sharing the credit lock would serialize deposits against
    // every balance mutation for no gain.
    expect(f.em.execute.mock.calls[0][1]).toEqual(['globepay-deposit:cus_1']);
  });

  it('runs the count and the insert on the LOCKED context', async () => {
    const f = fakeService(0);
    await f.svc.createGlobePayDepositCapped(input, f.ctx);

    // The load-bearing argument. Without it the count runs on a fresh pool
    // connection outside the transaction, and the lock stops meaning anything.
    expect(f.calls.listAndCountGlobePayDeposits.mock.calls[0][2]).toBe(f.ctx);
    expect(f.calls.createGlobePayDeposits.mock.calls[0][1]).toBe(f.ctx);
  });

  it('scopes the count to this customer, to pending only, and to the window', async () => {
    const f = fakeService(0);
    await f.svc.createGlobePayDepositCapped(input, f.ctx);

    const filter = f.calls.listAndCountGlobePayDeposits.mock
      .calls[0][0] as unknown as {
      customer_id: string;
      status: string;
      created_at: { $gte: Date };
    };
    expect(filter.customer_id).toBe('cus_1');
    expect(filter.status).toBe('pending');
    // Window-scoped on purpose: there is no customer-facing cancel endpoint, so
    // an unscoped cap would lock out someone who merely closed a few cashier
    // tabs until the sweep expired their rows.
    expect(filter.created_at.$gte).toBeInstanceOf(Date);
    expect(Date.now() - filter.created_at.$gte.getTime()).toBeCloseTo(
      input.windowMs,
      -3,
    );
  });

  it('returns null and writes NOTHING once the count is at the cap', async () => {
    const f = fakeService(input.maxRecentPending);
    const row = await f.svc.createGlobePayDepositCapped(input, f.ctx);

    expect(row).toBeNull();
    expect(f.calls.createGlobePayDeposits).not.toHaveBeenCalled();
    expect(f.ops).toEqual(['lock', 'count']);
  });

  it('allows the request one below the cap', async () => {
    const f = fakeService(input.maxRecentPending - 1);
    await expect(
      f.svc.createGlobePayDepositCapped(input, f.ctx),
    ).resolves.toEqual({ id: 'gpd_1' });
    expect(f.calls.createGlobePayDeposits).toHaveBeenCalled();
  });
});
