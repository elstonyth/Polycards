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

// purgeAccountPacksData is @InjectTransactionManager, which REUSES a provided
// sharedContext.transactionManager and calls the real method — so a bare
// prototype plus a fake `em` drives the whole purge with no database. Idiom:
// customer-metadata-lock.unit.spec.ts:28-51.
type PurgeSvc = PacksModuleService & {
  deleteAccountPreflight: jest.Mock;
  listCustomerAccountStates: jest.Mock;
  createCustomerAccountStates: jest.Mock;
  updateCustomerAccountStates: jest.Mock;
  listAdminActionAudits: jest.Mock;
  createAdminActionAudits: jest.Mock;
};

const mkPurge = () => {
  const svc = Object.create(PacksModuleService.prototype) as PurgeSvc;
  const sql: string[] = [];
  const em = {
    execute: jest.fn(async (query: string) => {
      sql.push(query);
      return [];
    }),
  };
  // The in-lock re-check is part of the method under test, so the fake has to
  // answer it — without this the purge refuses before it scrubs anything.
  svc.deleteAccountPreflight = jest.fn().mockResolvedValue({ ok: true });
  svc.listCustomerAccountStates = jest.fn().mockResolvedValue([{ id: 'cas_1' }]);
  svc.createCustomerAccountStates = jest.fn().mockResolvedValue([]);
  svc.updateCustomerAccountStates = jest.fn().mockResolvedValue([]);
  svc.listAdminActionAudits = jest.fn().mockResolvedValue([]);
  svc.createAdminActionAudits = jest.fn().mockResolvedValue([]);
  return { svc, em, sql, ctx: { transactionManager: em } as never };
};

const writesIn = (sql: string[]) =>
  sql.filter((q) => /^\s*(update|delete)/i.test(q));

describe('purgeAccountPacksData', () => {
  it('takes the credit advisory lock FIRST, then re-runs the preflight inside it', async () => {
    const f = mkPurge();
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.sql[0]).toContain('pg_advisory_xact_lock');
    expect(f.svc.deleteAccountPreflight).toHaveBeenCalled();
    expect(
      f.svc.deleteAccountPreflight.mock.invocationCallOrder[0],
    ).toBeGreaterThan(f.em.execute.mock.invocationCallOrder[0]);
  });

  // The route's preflight runs in no transaction and holds no lock, so on its
  // own it leaves a window — minutes wide in production, because deposits are
  // credited by the reconcile sweep — in which a spin, sell, deposit credit or
  // withdrawal can land and be purged straight through. This re-check is what
  // closes it, so it gets its own test rather than riding on the happy path.
  it('refuses and writes NOTHING when the in-lock re-check fails', async () => {
    const f = mkPurge();
    f.svc.deleteAccountPreflight.mockResolvedValue({
      ok: false,
      reason: 'BALANCE_NOT_ZERO',
      detail: 'Wallet balance is RM 12.50.',
    });
    await expect(f.svc.purgeAccountPacksData('cus_1', f.ctx)).rejects.toThrow(
      /BALANCE_NOT_ZERO/,
    );
    expect(writesIn(f.sql)).toHaveLength(0);
    expect(f.svc.createAdminActionAudits).not.toHaveBeenCalled();
  });

  it('scrubs the retained financial rows and deletes the pure-PII ones', async () => {
    const f = mkPurge();
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    const all = f.sql.join('\n');
    expect(all).toContain('globepay_withdrawal');
    expect(all).toContain('right("account_number", 4)');
    // NOT NULL columns, so '' rather than null — a null here is a constraint
    // violation that fails the whole purge on the first real delete.
    expect(all).toContain(`"account_holder_name" = ''`);
    expect(all).toContain('delivery_order');
    expect(all).toContain('"proof_images" = null');
    expect(writesIn(f.sql).join('\n')).toContain(
      'delete from "player_payout_details"',
    );
    expect(writesIn(f.sql).join('\n')).toContain(
      'delete from "notification_read"',
    );
  });

  // The row IS the tombstone. Soft-deleting it re-opens the account:
  // accountDisabledCause reads through listCustomerAccountStates, which
  // excludes soft-deleted rows, so it would return null and the session guard
  // would wave a still-valid bearer straight through.
  it('tombstones the account-state row instead of soft-deleting it', async () => {
    const f = mkPurge();
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.svc.updateCustomerAccountStates).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          disabled: true,
          disabled_cause: 'admin',
          disabled_reason: 'Account deleted by the customer.',
        }),
      }),
      expect.anything(),
    );
    expect(f.sql.join('\n')).not.toMatch(
      /customer_account_state[\s\S]*deleted_at/i,
    );
  });

  // Most customers have never been disabled or frozen, so they have NO
  // account-state row at all — setAccountDisabled creates it lazily. An update
  // that no-ops for them would leave the commonest account with no tombstone
  // and a bearer that keeps working for the rest of its TTL.
  it('CREATES the tombstone when the customer has no account-state row', async () => {
    const f = mkPurge();
    f.svc.listCustomerAccountStates.mockResolvedValue([]);
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.svc.createCustomerAccountStates).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          customer_id: 'cus_1',
          disabled: true,
          disabled_cause: 'admin',
        }),
      ],
      expect.anything(),
    );
    expect(f.svc.updateCustomerAccountStates).not.toHaveBeenCalled();
  });

  it('writes the delete_account audit row', async () => {
    const f = mkPurge();
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.svc.createAdminActionAudits).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          admin_id: 'cus_1',
          entity_id: 'cus_1',
          action: 'delete_account',
        }),
      ],
      expect.anything(),
    );
  });

  // The route is re-runnable after a partial failure, so the audit write has
  // to be too: a trail that grows a row per retry reports one deletion as
  // several.
  it('does not stack a second audit row on a retry', async () => {
    const f = mkPurge();
    f.svc.listAdminActionAudits.mockResolvedValue([{ id: 'aud_1' }]);
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.svc.createAdminActionAudits).not.toHaveBeenCalled();
  });
});
