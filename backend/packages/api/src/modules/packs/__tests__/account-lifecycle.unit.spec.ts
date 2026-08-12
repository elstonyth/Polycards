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
