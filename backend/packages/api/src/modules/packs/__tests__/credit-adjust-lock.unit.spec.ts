import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../service';

/**
 * adminAdjustCredit — the rolling-24h GLOBAL mint ceiling
 * (ADJUST_DAILY_MINT_MAX_RM) is enforced under a CONSTANT-key advisory lock, in
 * the same transaction as the write.
 *
 * WHY THIS FILE EXISTS: the HTTP ceiling tests pass with or without the lock.
 * They grant, commit, then grant again, so the window sum sees the first row
 * whether it runs inside the locked transaction or on a fresh pool connection.
 * Delete the pg_advisory_xact_lock line and every one of them stays green —
 * which would leave the entire point of the lock (50 parallel grants to 50
 * different customers each reading a stale window) pinned by nothing.
 *
 * HONESTY NOTE ON COVERAGE: a jest unit test with no database cannot execute
 * two real transactions against one Postgres advisory lock, so nothing below
 * proves the burst race is closed. What is pinned is the ORDERING and SCOPE
 * that make closing it possible — lock first, on a constant key, sum after it,
 * no customer binding on the sum, and no global lock at all for a clawback.
 * Same fake-`this` technique as customer-metadata-lock.unit.spec.ts:
 * @InjectTransactionManager reuses a provided `sharedContext.transactionManager`
 * and calls the original method.
 */

const MINT_LOCK_KEY = 'credit-adjust:mint-window';

/** The lock and the window sum are both raw SQL on ONE `em`, so the ordered log
 *  is built by classifying the SQL itself — that is what makes the sum drifting
 *  back out in front of the lock visible. */
const fakeService = (windowCents = 0) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const ops: string[] = [];
  const em = {
    execute: jest.fn(async (query: string, _params?: unknown[]) => {
      if (query.includes('pg_advisory_xact_lock')) {
        ops.push('lock');
        return [];
      }
      ops.push('window');
      return [{ sum_cents: String(windowCents) }];
    }),
  };
  // The write half is stubbed: this file is about what happens BEFORE it.
  // Own properties shadow the decorated prototype methods.
  const writes = {
    mutateCreditAtomic: jest.fn(async () => ({
      id: 'ctx_1',
      balance: 5,
      amount: 5,
      replayed: false,
      reference: null,
    })),
    createAdminActionAudits: jest.fn(async () => []),
    recordLedgerEntry: jest.fn(async () => undefined),
  };
  Object.assign(svc, writes);
  // BOTH keys: adminAdjustCredit is @InjectTransactionManager (reuses
  // `transactionManager`), and the window read it calls is @InjectManager,
  // which resolves `manager` and refuses a context carrying neither. Same
  // object either way, so the ordered log above stays single-stream — which is
  // also what makes "the sum ran on the locked em" observable here.
  return {
    svc,
    em,
    ops,
    writes,
    ctx: { transactionManager: em, manager: em } as never,
  };
};

/** The `?`-params of the nth em.execute call. */
const paramsOf = (em: { execute: jest.Mock }, n: number) =>
  em.execute.mock.calls[n][1] as unknown[] | undefined;

const grant = (amount: number) => ({
  customerId: 'cus_1',
  amount,
  note: 'test',
  adminId: 'adm_1',
});

describe('PacksModuleService.adminAdjustCredit — mint-window lock', () => {
  it('takes the GLOBAL mint lock BEFORE summing the window, then writes', async () => {
    const f = fakeService(0);
    await f.svc.adminAdjustCredit(grant(5), f.ctx);

    expect(f.em.execute.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    // A CONSTANT key, not `credit:<customer>`: a per-customer key cannot bound
    // a global total, which is the whole reason this lock exists.
    expect(paramsOf(f.em, 0)).toEqual([MINT_LOCK_KEY]);
    expect(f.ops).toEqual(['lock', 'window']);
    expect(f.writes.mutateCreditAtomic).toHaveBeenCalledTimes(1);
  });

  it('sums the window with NO customer binding (the cap is global)', async () => {
    const f = fakeService(0);
    await f.svc.adminAdjustCredit(grant(5), f.ctx);

    const [sql] = f.em.execute.mock.calls[1];
    expect(sql).toContain("reason = 'adjustment'");
    expect(sql).toContain('amount > 0'); // clawbacks never count
    expect(sql).toContain("created_at > now() - interval '24 hours'");
    expect(sql).toContain('deleted_at IS NULL'); // a compensated row must not count
    // The two properties a copy of the per-customer withdrawal cap would break.
    expect(sql).not.toContain('customer_id');
    expect(paramsOf(f.em, 1) ?? []).toEqual([]);
  });

  it('takes NO global lock for a clawback', async () => {
    const f = fakeService(0);
    await f.svc.adminAdjustCredit(grant(-5), f.ctx);

    // Negative adjustments are never blocked and never counted, so they must
    // never contend with a grant for the global lock.
    expect(f.ops).toEqual([]);
    expect(f.em.execute).not.toHaveBeenCalled();
    expect(f.writes.mutateCreditAtomic).toHaveBeenCalledTimes(1);
  });

  it('refuses over-cap under the lock, before any write', async () => {
    // Window already at RM 1,000,000 — the default ceiling.
    const f = fakeService(1_000_000_00);
    await expect(f.svc.adminAdjustCredit(grant(0.01), f.ctx)).rejects.toThrow(
      /ADJUST_DAILY_MINT_MAX_RM/,
    );

    expect(f.ops).toEqual(['lock', 'window']);
    // The refusal must land BEFORE the ledger row, not compensate one away.
    expect(f.writes.mutateCreditAtomic).not.toHaveBeenCalled();
    await expect(
      f.svc.adminAdjustCredit(grant(0.01), fakeService(1_000_000_00).ctx),
    ).rejects.toBeInstanceOf(MedusaError);
  });
});
