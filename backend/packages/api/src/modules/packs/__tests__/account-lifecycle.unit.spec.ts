import PacksModuleService from '../service';

type Svc = PacksModuleService & {
  listCustomerAccountStates: jest.Mock;
};

// Non-empty on purpose. @InjectManager throws unless the context carries a
// manager, and `isPresent({})` is FALSE (it tests Object.keys().length > 0), so
// a bare `{}` still throws — every method under test here is @InjectManager.
// @InjectTransactionManager is the one that short-circuits on
// `context.transactionManager`, which is why this repo's other fake-service
// specs get away with less. Precedent: credit-balance.unit.spec.ts:21-37.
const CTX = { manager: { probe: true } } as never;

const mkService = (): Svc => {
  const svc = Object.create(PacksModuleService.prototype) as Svc;
  svc.listCustomerAccountStates = jest.fn();
  return svc;
};

describe('accountDisabledCause', () => {
  it('returns null when the account is not disabled', async () => {
    const svc = mkService();
    svc.listCustomerAccountStates.mockResolvedValue([]);
    await expect(svc.accountDisabledCause('cus_1', CTX)).resolves.toBeNull();
  });

  it('returns self for a customer self-disable', async () => {
    const svc = mkService();
    svc.listCustomerAccountStates.mockResolvedValue([
      { disabled: true, disabled_cause: 'self' },
    ]);
    await expect(svc.accountDisabledCause('cus_1', CTX)).resolves.toBe('self');
  });

  // The fail-closed property: a disabled row whose cause predates the column
  // must behave as an admin disable, never as a self-disable (which would let
  // it through the login guard).
  it('treats a NULL cause on a disabled row as admin', async () => {
    const svc = mkService();
    svc.listCustomerAccountStates.mockResolvedValue([
      { disabled: true, disabled_cause: null },
    ]);
    await expect(svc.accountDisabledCause('cus_1', CTX)).resolves.toBe('admin');
  });
});

// rawLedgerBalanceCents RESOLVES the manager out of the context and calls
// .execute() on it, so it needs a context whose manager IS the fake em — CTX's
// probe object would only get as far as "em.execute is not a function". Two
// context shapes in one file, deliberately; do not collapse them.
const mkBalance = (balanceCents: string | null) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const em = {
    execute: jest.fn().mockResolvedValue([{ balance_cents: balanceCents }]),
  };
  return { svc, em, ctx: { manager: em } as never };
};

describe('rawLedgerBalanceCents', () => {
  it('returns integer cents, and scans credit_transaction for this customer', async () => {
    const f = mkBalance('2500');
    await expect(f.svc.rawLedgerBalanceCents('cus_1', f.ctx)).resolves.toBe(
      2500,
    );
    const [sql, params] = f.em.execute.mock.calls[0];
    expect(sql).toContain('credit_transaction');
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual(['cus_1']);
    // Lock-blindness, pinned. Without these two, re-adding the
    // lockedCommissionCents subtraction still passes every test in this file:
    // the fake em answers the SECOND query with the balance row too, so
    // `rows[0]?.locked_cents` is undefined → 0 → the total is unchanged. A
    // customer whose whole balance is locked commission would then read 0 and
    // clear the deletion gate with real money stranded.
    expect(sql).not.toMatch(/commission/i);
    expect(f.em.execute).toHaveBeenCalledTimes(1);
  });

  // The security-relevant direction, and the one that never touched Postgres
  // before this test existed: a clawback-negative account OWES money. A read
  // that clamped it at 0 would let it delete its way out of the debt.
  it('returns a NEGATIVE number for a clawback-negative account', async () => {
    const f = mkBalance('-500');
    await expect(f.svc.rawLedgerBalanceCents('cus_1', f.ctx)).resolves.toBe(
      -500,
    );
  });

  it('reads an empty ledger as 0', async () => {
    const f = mkBalance(null);
    await expect(f.svc.rawLedgerBalanceCents('cus_1', f.ctx)).resolves.toBe(0);
  });
});

type PreflightSvc = PacksModuleService & {
  rawLedgerBalanceCents: jest.Mock;
  listGlobePayWithdrawals: jest.Mock;
  listGlobePayDeposits: jest.Mock;
  listPulls: jest.Mock;
  listDeliveryOrders: jest.Mock;
};

const mkPreflight = (): PreflightSvc => {
  const svc = Object.create(PacksModuleService.prototype) as PreflightSvc;
  svc.rawLedgerBalanceCents = jest.fn().mockResolvedValue(0);
  svc.listGlobePayWithdrawals = jest.fn().mockResolvedValue([]);
  svc.listGlobePayDeposits = jest.fn().mockResolvedValue([]);
  svc.listPulls = jest.fn().mockResolvedValue([]);
  svc.listDeliveryOrders = jest.fn().mockResolvedValue([]);
  return svc;
};

// @InjectManager forwards a COPY of the context, stamped with its own marker —
// the observed third argument is {"manager":{…},"__type":"MedusaContext"}, so a
// literal `{}` here could never match. objectContaining keeps the assertion
// discriminating: it still proves the context was threaded through.
const CTX_ARG = expect.objectContaining({ __type: 'MedusaContext' });

describe('deleteAccountPreflight', () => {
  it('passes a fully settled account', async () => {
    const svc = mkPreflight();
    await expect(svc.deleteAccountPreflight('cus_1', CTX)).resolves.toEqual({
      ok: true,
    });
  });

  it('blocks a positive balance', async () => {
    const svc = mkPreflight();
    svc.rawLedgerBalanceCents.mockResolvedValue(1250);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'BALANCE_NOT_ZERO' });
  });

  // The debt case. A clawback-negative account owes us money, and `> 0` would
  // have let it delete its way out.
  it('blocks a NEGATIVE balance', async () => {
    const svc = mkPreflight();
    svc.rawLedgerBalanceCents.mockResolvedValue(-500);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'BALANCE_NOT_ZERO' });
  });

  it('blocks a held withdrawal', async () => {
    const svc = mkPreflight();
    svc.listGlobePayWithdrawals.mockResolvedValue([{ id: 'w1' }]);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'WITHDRAWAL_PENDING' });
    expect(svc.listGlobePayWithdrawals).toHaveBeenCalledWith(
      { customer_id: 'cus_1', status: ['pending', 'held'] },
      { take: 1 },
      CTX_ARG,
    );
  });

  // The filter is asserted, not just the outcome: an `expired` deposit can
  // still settle (the reconcile sweep re-reads those rows and credits them),
  // so narrowing this back to 'pending' alone is a live money bug that no
  // outcome-only assertion would catch.
  it('blocks an in-flight deposit, including an expired one', async () => {
    const svc = mkPreflight();
    svc.listGlobePayDeposits.mockResolvedValue([{ id: 'd1' }]);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'DEPOSIT_PENDING' });
    expect(svc.listGlobePayDeposits).toHaveBeenCalledWith(
      { customer_id: 'cus_1', status: ['pending', 'expired'] },
      { take: 1 },
      CTX_ARG,
    );
  });

  it('blocks unsettled vault cards', async () => {
    const svc = mkPreflight();
    svc.listPulls.mockResolvedValue([{ id: 'p1' }]);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'CARDS_UNSETTLED' });
    expect(svc.listPulls).toHaveBeenCalledWith(
      { customer_id: 'cus_1', status: ['vaulted', 'delivering'] },
      { take: 1 },
      CTX_ARG,
    );
  });

  // The filter is pinned for the same reason the other three are, and this one
  // needs it most: the guard is stated as "NOT terminal" precisely so a status
  // added later cannot slip past it. Without this assertion the mock returns a
  // row whatever was asked, so swapping $nin for the fail-open enumeration —
  // or for `$nin: []` — leaves every test in this file green while a delivery
  // in a newly-added status ships to an address the purge already erased.
  it('blocks a delivery that has not reached a terminal status', async () => {
    const svc = mkPreflight();
    svc.listDeliveryOrders.mockResolvedValue([{ id: 'do1' }]);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'DELIVERY_IN_FLIGHT' });
    expect(svc.listDeliveryOrders).toHaveBeenCalledWith(
      { customer_id: 'cus_1', status: { $nin: ['completed', 'canceled'] } },
      { take: 1 },
      CTX_ARG,
    );
  });
});
