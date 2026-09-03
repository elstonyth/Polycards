import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../service';
import { REFERRAL_BIND_WINDOW_MS, REFERRAL_CLOSE_GRACE_MS } from '../referral';

/**
 * The referral engine's write paths, pinned without a DB (the fake-`this`
 * technique of delivery-transition-atomic.unit.spec.ts: the decorators reuse
 * a provided transactionManager and call the original method).
 *
 * What these own (review 2026-09):
 *  1. pay and void CLAIM a line with ONE conditional UPDATE … RETURNING id
 *     before any money moves — the generated selector-update is a
 *     find-then-write with no row lock, so a void racing the pay job could
 *     land between the credit and the "status guard" and leave a paid line
 *     reading 'voided'.
 *  2. approve refuses (and does not audit) when the conditional UPDATE
 *     matched nothing.
 *  3. the cron close defers inside REFERRAL_CLOSE_GRACE_MS of the boundary;
 *     an explicit weekStartIso is not held back.
 *  4. bind refuses an account older than REFERRAL_BIND_WINDOW_MS before it
 *     even reads the ledger.
 *
 * The mutex itself is a Postgres property (the predicate is re-evaluated
 * against committed state after the row lock releases); the integration
 * specs run the real thing. What is pinned here is the SHAPE — claim first,
 * money only on a returned row.
 */

type Row = Record<string, unknown>;

const LINE = {
  id: 'wsl_1',
  settlement_id: 'ws_1',
  customer_id: 'cus_r',
  basis_cents: 100_000,
  rate_bp: 50,
  amount_cents: 500,
  status: 'pending',
};
const RUN = {
  id: 'ws_1',
  status: 'approved',
  week_start: new Date('2026-08-24T16:00:00Z'),
  total_commission_cents: 500,
};

function fake(returned: Row[] | (() => Row[])) {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const ops: string[] = [];
  const em = {
    execute: jest.fn(async (_q: string, _p?: unknown[]) => {
      ops.push('claim');
      return typeof returned === 'function' ? returned() : returned;
    }),
  };
  const fns = {
    listWeeklySettlements: jest.fn(async () => [RUN]),
    listWeeklySettlementLines: jest
      .fn()
      .mockResolvedValueOnce([LINE])
      .mockResolvedValue([]),
    deletedCustomerIds: jest.fn(async () => new Set<string>()),
    recordLedgerEntry: jest.fn(async () => {
      ops.push('ledger');
      return { id: 'led_1', display_id: 'RF26Q3A0001', replayed: false };
    }),
    createCreditTransactions: jest.fn(async () => {
      ops.push('credit');
      return [{ id: 'ct_1' }];
    }),
    updateWeeklySettlementLines: jest.fn(async () => []),
    updateWeeklySettlements: jest.fn(async () => []),
    createAdminActionAudits: jest.fn(async () => []),
    deductRunTotal: jest.fn(async () => undefined),
    listReferralAttributions: jest.fn(async () => []),
    createReferralAttributions: jest.fn(async () => []),
    // bindReferral rechecks the referrer's disabled flag inside its
    // transaction (review 2026-09-03); no state row = not disabled.
    listCustomerAccountStates: jest.fn(
      async (): Promise<{ customer_id: string; disabled: boolean }[]> => [],
    ),
  };
  Object.assign(svc, fns);
  const ctx = { manager: em, transactionManager: em } as never;
  return { svc, em, ops, ctx, ...fns };
}

describe('payWeeklySettlement claims a line before it moves money', () => {
  it('claims with ONE conditional UPDATE … RETURNING, then ledger, then credit', async () => {
    const f = fake([{ id: 'wsl_1' }]);
    const res = await f.svc.payWeeklySettlement(
      { settlementId: 'ws_1' },
      f.ctx,
    );

    expect(res).toEqual({
      paid: 1,
      skipped: 0,
      paid_customer_ids: ['cus_r'],
    });
    const [sql, params] = f.em.execute.mock.calls[0];
    expect(sql).toMatch(/^UPDATE weekly_settlement_line/);
    expect(sql).toContain("SET status = 'paid'");
    // The FROM-state is part of the predicate — the write and the check
    // cannot be separated by another transaction.
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain('RETURNING id');
    expect(params).toEqual(['wsl_1']);
    expect(f.ops).toEqual(['claim', 'ledger', 'credit']);
    // The stamp needs no status guard any more — the row is ours.
    expect(f.updateWeeklySettlementLines).toHaveBeenCalledWith(
      { selector: { id: 'wsl_1' }, data: { paid_transaction_id: 'ct_1' } },
      expect.anything(),
    );
  });

  it('a lost claim (voided since the list) moves NO money and stamps nothing', async () => {
    const f = fake([]);
    const res = await f.svc.payWeeklySettlement(
      { settlementId: 'ws_1' },
      f.ctx,
    );

    expect(res.paid).toBe(0);
    expect(res.paid_customer_ids).toEqual([]);
    expect(f.recordLedgerEntry).not.toHaveBeenCalled();
    expect(f.createCreditTransactions).not.toHaveBeenCalled();
    expect(f.updateWeeklySettlementLines).not.toHaveBeenCalled();
    // No money moved → nothing to audit as a payout.
    expect(f.createAdminActionAudits).not.toHaveBeenCalled();
  });

  it('a replayed RF row (crash-window re-run) mints no second credit; the claim already repaired the line', async () => {
    const f = fake([{ id: 'wsl_1' }]);
    f.recordLedgerEntry.mockResolvedValueOnce({
      id: 'led_old',
      display_id: 'RF26Q3A0001',
      replayed: true,
    });
    const res = await f.svc.payWeeklySettlement(
      { settlementId: 'ws_1' },
      f.ctx,
    );

    expect(res.paid).toBe(0);
    expect(f.createCreditTransactions).not.toHaveBeenCalled();
    expect(f.updateWeeklySettlementLines).not.toHaveBeenCalled();
  });

  it('a deleted account is voided through the same claim; a lost claim skips the deduction', async () => {
    const won = fake([{ id: 'wsl_1' }]);
    won.deletedCustomerIds.mockResolvedValue(new Set(['cus_r']));
    const r1 = await won.svc.payWeeklySettlement(
      { settlementId: 'ws_1' },
      won.ctx,
    );
    expect(r1).toEqual({ paid: 0, skipped: 1, paid_customer_ids: [] });
    const [sql, params] = won.em.execute.mock.calls[0];
    expect(sql).toContain(
      "SET status = 'voided', void_reason = 'account_deleted'",
    );
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('RETURNING id');
    expect(params).toEqual(['wsl_1']);
    expect(won.deductRunTotal).toHaveBeenCalledTimes(1);
    expect(won.recordLedgerEntry).not.toHaveBeenCalled();

    // An admin void got there first — it already took its deduction.
    const lost = fake([]);
    lost.deletedCustomerIds.mockResolvedValue(new Set(['cus_r']));
    const r2 = await lost.svc.payWeeklySettlement(
      { settlementId: 'ws_1' },
      lost.ctx,
    );
    expect(r2.skipped).toBe(0);
    expect(lost.deductRunTotal).not.toHaveBeenCalled();
  });
});

describe('voidSettlementLine claims the line the same way', () => {
  it('ONE conditional UPDATE from pending, answered by RETURNING', async () => {
    const f = fake([{ id: 'wsl_1' }]);
    await f.svc.voidSettlementLine(
      { lineId: 'wsl_1', adminId: 'adm_1', reason: 'suspicious' },
      f.ctx,
    );
    const [sql, params] = f.em.execute.mock.calls[0];
    expect(sql).toMatch(/^UPDATE weekly_settlement_line/);
    expect(sql).toContain("SET status = 'voided'");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('RETURNING id');
    expect(params).toEqual(['suspicious', 'adm_1', 'wsl_1']);
    expect(f.deductRunTotal).toHaveBeenCalledWith(
      { settlementId: 'ws_1', amountCents: 500 },
      expect.anything(),
    );
    expect(f.createAdminActionAudits).toHaveBeenCalledTimes(1);
  });

  it('a lost claim (pay got there first) refuses cleanly — no deduction, no audit', async () => {
    const f = fake([]);
    await expect(
      f.svc.voidSettlementLine(
        { lineId: 'wsl_1', adminId: 'adm_1', reason: 'late' },
        f.ctx,
      ),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/changed state/),
    });
    expect(f.deductRunTotal).not.toHaveBeenCalled();
    expect(f.createAdminActionAudits).not.toHaveBeenCalled();
  });
});

describe('approveWeeklySettlement', () => {
  it('approves with ONE conditional UPDATE from draft and audits only then', async () => {
    const f = fake([{ id: 'ws_1' }]);
    f.listWeeklySettlements.mockResolvedValue([{ ...RUN, status: 'draft' }]);
    await f.svc.approveWeeklySettlement(
      { settlementId: 'ws_1', adminId: 'adm_1' },
      f.ctx,
    );
    const [sql, params] = f.em.execute.mock.calls[0];
    expect(sql).toMatch(/^UPDATE weekly_settlement /);
    expect(sql).toContain("SET status = 'approved'");
    expect(sql).toContain("status = 'draft'");
    expect(sql).toContain('RETURNING id');
    expect(params).toEqual(['adm_1', 'ws_1']);
    expect(f.createAdminActionAudits).toHaveBeenCalledTimes(1);
  });

  it('a void that won the race leaves NO approve_settlement audit row', async () => {
    const f = fake([]);
    f.listWeeklySettlements.mockResolvedValue([{ ...RUN, status: 'draft' }]);
    await expect(
      f.svc.approveWeeklySettlement(
        { settlementId: 'ws_1', adminId: 'adm_1' },
        f.ctx,
      ),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
    expect(f.createAdminActionAudits).not.toHaveBeenCalled();
  });
});

describe('closeReferralWeek grace', () => {
  // Tue 2026-09-01 00:00 MYT = 2026-08-31T16:00Z: the boundary the hourly
  // cron fires on, and lastClosedReferralWeek(now).endUtcExcl for any `now`
  // in the following week.
  const BOUNDARY = new Date('2026-08-31T16:00:00Z');

  it('the cron path defers while the boundary is inside the grace', async () => {
    const f = fake([]);
    const res = await f.svc.closeReferralWeek(
      { now: new Date(BOUNDARY.getTime() + 1_000) },
      f.ctx,
    );
    expect(res).toEqual({ settlementId: null, created: false, lines: 0 });
    // Nothing was read, let alone snapshotted.
    expect(f.listWeeklySettlements).not.toHaveBeenCalled();
    expect(f.em.execute).not.toHaveBeenCalled();
  });

  it('…and proceeds once the grace has passed', async () => {
    const f = fake([]);
    f.listWeeklySettlements.mockResolvedValue([{ ...RUN, id: 'ws_prev' }]);
    const res = await f.svc.closeReferralWeek(
      { now: new Date(BOUNDARY.getTime() + REFERRAL_CLOSE_GRACE_MS) },
      f.ctx,
    );
    expect(res).toEqual({ settlementId: 'ws_prev', created: false, lines: 0 });
    expect(f.listWeeklySettlements).toHaveBeenCalledWith(
      { week_start: new Date('2026-08-24T16:00:00Z') },
      { take: 1 },
      expect.anything(),
    );
  });

  it('an explicit weekStartIso is the operator lever and is not held back', async () => {
    const f = fake([]);
    f.listWeeklySettlements.mockResolvedValue([{ ...RUN, id: 'ws_now' }]);
    const res = await f.svc.closeReferralWeek(
      { weekStartIso: '2026-09-01', now: new Date(BOUNDARY.getTime() + 1_000) },
      f.ctx,
    );
    expect(res.settlementId).toBe('ws_now');
    expect(f.listWeeklySettlements).toHaveBeenCalledTimes(1);
  });
});

describe('bindReferral signup window', () => {
  const NOW = new Date('2026-09-02T04:00:00Z');

  it('refuses an account older than the window BEFORE reading the ledger', async () => {
    const f = fake([{ n: '0' }]);
    const res = await f.svc.bindReferral(
      {
        customerId: 'cus_old',
        referrerId: 'cus_r',
        createdAt: new Date(NOW.getTime() - REFERRAL_BIND_WINDOW_MS - 1),
        now: NOW,
      },
      f.ctx,
    );
    expect(res).toEqual({ bound: false, reason: 'not_a_new_account' });
    expect(f.em.execute).not.toHaveBeenCalled();
    expect(f.createReferralAttributions).not.toHaveBeenCalled();
  });

  it('binds a fresh, unspent account', async () => {
    const f = fake([{ n: '0' }]);
    const res = await f.svc.bindReferral(
      {
        customerId: 'cus_new',
        referrerId: 'cus_r',
        createdAt: new Date(NOW.getTime() - 60_000),
        now: NOW,
      },
      f.ctx,
    );
    expect(res).toEqual({ bound: true });
    expect(f.createReferralAttributions).toHaveBeenCalledTimes(1);
  });

  it('refuses a referrer disabled between the route check and the write', async () => {
    const f = fake([{ n: '0' }]);
    f.listCustomerAccountStates.mockResolvedValue([
      { customer_id: 'cus_r', disabled: true },
    ]);
    const res = await f.svc.bindReferral(
      {
        customerId: 'cus_new',
        referrerId: 'cus_r',
        createdAt: new Date(NOW.getTime() - 60_000),
        now: NOW,
      },
      f.ctx,
    );
    expect(res).toEqual({ bound: false, reason: 'referrer_disabled' });
    expect(f.createReferralAttributions).not.toHaveBeenCalled();
  });

  it('still refuses a young account that already opened a pack', async () => {
    const f = fake([{ n: '1' }]);
    const res = await f.svc.bindReferral(
      {
        customerId: 'cus_spent',
        referrerId: 'cus_r',
        createdAt: new Date(NOW.getTime() - 60_000),
        now: NOW,
      },
      f.ctx,
    );
    expect(res).toEqual({ bound: false, reason: 'not_a_new_account' });
    expect(f.createReferralAttributions).not.toHaveBeenCalled();
  });
});
