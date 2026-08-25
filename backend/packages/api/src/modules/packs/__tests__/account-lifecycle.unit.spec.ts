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
  listCustomerAccountStates: jest.Mock;
  listGlobePayWithdrawals: jest.Mock;
  listGlobePayDeposits: jest.Mock;
  listPulls: jest.Mock;
  listDeliveryOrders: jest.Mock;
};

const mkPreflight = (): PreflightSvc => {
  const svc = Object.create(PacksModuleService.prototype) as PreflightSvc;
  // isFrozen reads through this; [] = not frozen, the common case.
  svc.listCustomerAccountStates = jest.fn().mockResolvedValue([]);
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

  // The evidence case, and the one no other check catches. `frozen` is
  // ORTHOGONAL to `disabled` — no store middleware reads it — and
  // rawLedgerBalanceCents is deliberately freeze-blind, so an account under an
  // active clawback hold sitting at raw balance exactly 0 cleared every other
  // guard here. The purge then HARD-deletes player_payout_details (bank name,
  // full account number, holder name) and blanks
  // globepay_withdrawal.account_holder_name: exactly the records the freeze
  // exists to preserve. First, because it is the cheapest and the most
  // absolute.
  it('blocks a FROZEN account, before it even reads the balance', async () => {
    const svc = mkPreflight();
    svc.listCustomerAccountStates.mockResolvedValue([{ id: 'cas_1' }]);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'ACCOUNT_FROZEN' });
    expect(svc.listCustomerAccountStates).toHaveBeenCalledWith(
      { customer_id: 'cus_1', frozen: true },
      { take: 1 },
      CTX_ARG,
    );
    expect(svc.rawLedgerBalanceCents).not.toHaveBeenCalled();
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
  // isAccountDisabled reads through listCustomerAccountStates, which excludes
  // soft-deleted rows, so it would return false and the session guard would
  // wave a still-valid bearer straight through.
  it('tombstones the account-state row instead of soft-deleting it', async () => {
    const f = mkPurge();
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.svc.updateCustomerAccountStates).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          disabled: true,
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

  // A half-finished purge gets finished by hand, so the audit write has to
  // tolerate a second pass: a trail that grows a row per attempt reports one
  // deletion as several.
  it('does not stack a second audit row on a retry', async () => {
    const f = mkPurge();
    f.svc.listAdminActionAudits.mockResolvedValue([{ id: 'aud_1' }]);
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.svc.createAdminActionAudits).not.toHaveBeenCalled();
  });
});

describe('deletedCustomerIds', () => {
  it('returns the ids that have a delete_account audit row', async () => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as PacksModuleService & { listAdminActionAudits: jest.Mock };
    svc.listAdminActionAudits = jest
      .fn()
      .mockResolvedValue([{ entity_id: 'cus_2' }]);
    await expect(
      svc.deletedCustomerIds(['cus_1', 'cus_2'], CTX),
    ).resolves.toEqual(new Set(['cus_2']));
    // The filter is pinned, not just the outcome. Every caller of this read is
    // a money guard that FAILS OPEN on an empty Set, and the mock answers
    // whatever it is asked — so a filter that silently matched nothing (a
    // dropped `action`, an id list the query cannot express) would leave this
    // whole file green while a deleted account keeps getting paid.
    expect(svc.listAdminActionAudits).toHaveBeenCalledWith(
      {
        // entity_type leads the only usable index — dropping it is a full scan
        // on an append-only table, read inside settleOpen's advisory lock.
        entity_type: 'customer',
        entity_id: ['cus_1', 'cus_2'],
        action: 'delete_account',
      },
      // No `take`, and the empty config is asserted rather than `anything()`:
      // a bound here can only subtract. Two delete_account rows for one
      // customer (idempotency makes that unlikely, not impossible) would push
      // another customer's row past a length-based limit, and the id it dropped
      // would then be PAID.
      {},
      CTX_ARG,
    );
  });

  it('does not query at all for an empty ranking', async () => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as PacksModuleService & { listAdminActionAudits: jest.Mock };
    svc.listAdminActionAudits = jest.fn();
    await expect(svc.deletedCustomerIds([], CTX)).resolves.toEqual(new Set());
    expect(svc.listAdminActionAudits).not.toHaveBeenCalled();
  });
});

describe('disabledCustomerIds', () => {
  it('returns the ids whose account state is disabled', async () => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as PacksModuleService & { listCustomerAccountStates: jest.Mock };
    svc.listCustomerAccountStates = jest
      .fn()
      .mockResolvedValue([{ customer_id: 'cus_2' }]);
    await expect(
      svc.disabledCustomerIds(['cus_1', 'cus_2'], CTX),
    ).resolves.toEqual(new Set(['cus_2']));
    // Same reason the sibling read above pins its filter: the mock answers
    // whatever it is asked, so a filter that quietly matched the WRONG rows
    // would leave this file green. Both halves are load-bearing in opposite
    // directions — drop `disabled` and every account-state row matches, which
    // hides frozen and merely phone-verified players from the public boards;
    // drop the id list and it becomes a full scan on a table that grows with
    // every disable, freeze and phone verification.
    expect(svc.listCustomerAccountStates).toHaveBeenCalledWith(
      { customer_id: ['cus_1', 'cus_2'], disabled: true },
      // No `take`, asserted as the empty config rather than anything(): a bound
      // can only subtract here, and the id it dropped would be a disabled
      // player PUBLISHED on the leaderboard.
      {},
      CTX_ARG,
    );
  });

  it('does not query at all for an empty ranking', async () => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as PacksModuleService & { listCustomerAccountStates: jest.Mock };
    svc.listCustomerAccountStates = jest.fn();
    await expect(svc.disabledCustomerIds([], CTX)).resolves.toEqual(new Set());
    expect(svc.listCustomerAccountStates).not.toHaveBeenCalled();
  });
});

describe('settleChallengeWeek — deleted winners', () => {
  // Enough of the enumerator to reach the winner loop: everything it reads
  // before paying anyone, stubbed with the smallest shape that satisfies it.
  // settleChallengeWinner is `protected` and reserveSettledStock `private`, so
  // the fake is typed as its mocks alone rather than intersected with the
  // class — the prototype underneath is still the real one.
  type SettleSvc = Record<string, jest.Mock> & {
    settleChallengeWeek: PacksModuleService['settleChallengeWeek'];
  };
  const mkSettle = (deleted: string[]) => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as unknown as SettleSvc;
    svc.challengeSettings = jest.fn().mockResolvedValue({
      timezone: 'Asia/Kuala_Lumpur',
      reset_day: 1,
      reset_hour: 0,
    });
    svc.challengeWeekBounds = jest.fn().mockResolvedValue({
      startUtc: new Date('2026-08-03T00:00:00Z'),
      endUtc: new Date('2026-08-10T00:00:00Z'),
    });
    svc.listChallengePayouts = jest.fn().mockResolvedValue([]);
    // threshold 0 against a non-zero pool => stage 1 unlocks; rank 1 pays
    // credits, so the loop's "rank pays nothing" gate does not swallow it.
    svc.listChallengeStages = jest.fn().mockResolvedValue([
      {
        stage_number: 1,
        threshold_myr: 0,
        rank_rewards: [{ rank: 1, credits: 100, card_id: null }],
      },
    ]);
    svc.challengeWeekPool = jest.fn().mockResolvedValue(9_999);
    svc.challengeWeekTop = jest
      .fn()
      .mockResolvedValue([{ customer_id: 'cus_gone' }]);
    svc.listCards = jest.fn().mockResolvedValue([]);
    // Answers the ids it is ACTUALLY given, never a canned Set: a
    // mockResolvedValue here cannot see its own argument, so narrowing the
    // call to `deletedCustomerIds([], …)` — which makes the whole guard a
    // no-op — would leave every test in this file green.
    const gone = new Set(deleted);
    svc.deletedCustomerIds = jest
      .fn()
      .mockImplementation(async (ids: string[]) =>
        new Set(ids.filter((id) => gone.has(id))),
      );
    svc.settleChallengeWinner = jest.fn().mockResolvedValue(null);
    svc.reserveSettledStock = jest.fn().mockResolvedValue(undefined);
    return svc;
  };

  // Real balance and a real card, minted to an account with no owner. `pull`
  // rows are retained by design, so a deleted customer stays ranked.
  it('pays nothing to a deleted winner', async () => {
    const svc = mkSettle(['cus_gone']);
    const result = await svc.settleChallengeWeek({}, CTX);
    expect(svc.settleChallengeWinner).not.toHaveBeenCalled();
    expect(result.winners).toEqual([]);
    // The RANKING is what must be asked about. Without this, narrowing the
    // read to a list that cannot match anyone still passes above.
    expect(svc.deletedCustomerIds).toHaveBeenCalledWith(
      ['cus_gone'],
      expect.anything(),
    );
  });

  // The other direction, and the one that proves the fixture actually reaches
  // the loop: without it, a stub that fell out of step with the enumerator
  // would make the test above pass for the wrong reason.
  it('still pays a live winner', async () => {
    const svc = mkSettle([]);
    await svc.settleChallengeWeek({}, CTX);
    expect(svc.settleChallengeWinner).toHaveBeenCalled();
  });
});
