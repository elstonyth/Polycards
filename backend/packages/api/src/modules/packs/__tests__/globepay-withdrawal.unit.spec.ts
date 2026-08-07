import { MedusaError } from '@medusajs/framework/utils';
import {
  globepayWithdrawalsEnabled,
  startGlobePayWithdrawal,
  withdrawalDetailsError,
  withdrawalIdempotencyReference,
  withdrawalRefundReference,
} from '../globepay-withdrawal';
import {
  unknownWithdrawalAction,
  withdrawalReconcileAction,
} from '../globepay-reconcile';
import PacksModuleService from '../service';
import { POST as withdrawRoute } from '../../../api/store/credits/withdraw/route';

// startGlobePayWithdrawal talks to the gateway through globepay-client; stub
// that seam so these tests cover the MONEY ORDERING (row -> debit -> gateway,
// refund on refusal) rather than the HTTP layer.
jest.mock('../globepay-client', () => {
  const actual = jest.requireActual('../globepay-client');
  return {
    ...actual,
    globepayConfigFromEnv: jest.fn(() => ({
      baseUrl: 'https://mapi.example.test',
      merchantCode: 'Testpolycard',
      aesKey: 'test-aes-key',
      privateKey: 'priv',
      publicKey: 'pub',
      currencyCode: 'MYR',
    })),
    submitWithdrawal: jest.fn(),
  };
});

import { GlobePayError, submitWithdrawal } from '../globepay-client';

const submitMock = submitWithdrawal as jest.Mock;

function harness() {
  const packs = {
    createGlobePayWithdrawals: jest.fn().mockResolvedValue([{ id: 'gpw_1' }]),
    updateGlobePayWithdrawals: jest.fn().mockResolvedValue(undefined),
    // The gate + debit unit. Everything the old caller-side policy check did
    // (freeze, locked commissions, playthrough, the daily cap) now happens
    // INSIDE this one service call, under the credit: advisory lock — see the
    // `PacksModuleService.withdrawForCashout` describe below, which exercises
    // the real thing against a fake `this`. Here it is stubbed, because these
    // tests own the MONEY ORDERING (row -> debit -> gateway, refund on refusal).
    withdrawForCashout: jest.fn().mockResolvedValue({
      id: 'ct_1',
      balance: 50,
      amount: -50,
      replayed: false,
      reference: null,
    }),
    // Still the REFUND writer on the payout path (positive amount, wd-refund:
    // anchor). The debit no longer goes through it directly.
    withdrawCreditsWithLedger: jest.fn().mockResolvedValue({
      id: 'ct_2',
      balance: 100,
      amount: 50,
      replayed: false,
      reference: null,
    }),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    packs,
    logger,
    scope: {
      resolve: (k: string) => (k === 'logger' ? logger : packs),
    } as never,
  };
}

const input = {
  customerId: 'cus_1',
  amount: 50,
  bankCode: 'MBB',
  accountNumber: '1234567890',
  accountHolderName: 'AHMAD BIN ALI',
  ipAddress: '1.2.3.4',
};

const start = (
  h: ReturnType<typeof harness>,
  over: Record<string, unknown> = {},
) =>
  startGlobePayWithdrawal(
    h.scope,
    { ...input, ...over },
    'https://us/notify-wd',
    'https://us/payout-verify',
  );

beforeEach(() => {
  submitMock.mockReset();
  submitMock.mockResolvedValue({ transactionId: 'W2026072200000001' });
  process.env.GLOBEPAY_ENABLED = 'true';
  process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'true';
  process.env.GLOBEPAY_MERCHANT_CODE = 'Testpolycard';
});

describe('globepayWithdrawalsEnabled', () => {
  it('is off unless BOTH switches are on and the merchant is configured', () => {
    expect(globepayWithdrawalsEnabled({})).toBe(false);
    expect(
      globepayWithdrawalsEnabled({
        GLOBEPAY_ENABLED: 'true',
        GLOBEPAY_MERCHANT_CODE: 'M',
      }),
    ).toBe(false);
    expect(
      globepayWithdrawalsEnabled({
        GLOBEPAY_WITHDRAWALS_ENABLED: 'true',
        GLOBEPAY_MERCHANT_CODE: 'M',
      }),
    ).toBe(false);
    expect(
      globepayWithdrawalsEnabled({
        GLOBEPAY_ENABLED: 'true',
        GLOBEPAY_WITHDRAWALS_ENABLED: 'true',
        GLOBEPAY_MERCHANT_CODE: 'M',
      }),
    ).toBe(true);
  });
});

describe('idempotency anchors', () => {
  it('debit and refund anchors NEVER collide, and are stable per payout', () => {
    const debit = withdrawalIdempotencyReference('cus_1', 'PC-abc');
    const refund = withdrawalRefundReference('cus_1', 'PC-abc');
    expect(debit).not.toBe(refund);
    expect(withdrawalIdempotencyReference('cus_1', 'PC-abc')).toBe(debit);
    expect(withdrawalRefundReference('cus_1', 'PC-abc')).toBe(refund);
    // Different customers or payouts -> different anchors.
    expect(withdrawalIdempotencyReference('cus_2', 'PC-abc')).not.toBe(debit);
    expect(withdrawalIdempotencyReference('cus_1', 'PC-def')).not.toBe(debit);
  });
});

describe('withdrawalDetailsError', () => {
  it('accepts sane bank details', () => {
    expect(withdrawalDetailsError(input)).toBeNull();
  });
  it.each([
    [{ ...input, bankCode: '' }, /bank/i],
    [{ ...input, bankCode: 'not a code!' }, /bank/i],
    [{ ...input, accountNumber: '12ab' }, /account number/i],
    [{ ...input, accountNumber: '12345' }, /account number/i],
    [{ ...input, accountHolderName: ' ' }, /holder name/i],
  ])('rejects bad details (%#)', (bad, message) => {
    expect(withdrawalDetailsError(bad)).toMatch(message);
  });
});

describe('startGlobePayWithdrawal — money ordering', () => {
  it('row, then DEBIT, then gateway — in that exact order', async () => {
    const h = harness();
    const order: string[] = [];
    h.packs.createGlobePayWithdrawals.mockImplementation(async () => {
      order.push('row');
      return [{ id: 'gpw_1' }];
    });
    h.packs.withdrawForCashout.mockImplementation(async () => {
      order.push('debit');
      return { id: 'ct_1', balance: 0, amount: -50, replayed: false };
    });
    submitMock.mockImplementation(async () => {
      order.push('gateway');
      return { transactionId: 'W1' };
    });

    await start(h);
    // Reversed, money could be queued to leave the merchant balance while the
    // customer's site balance still shows it.
    expect(order).toEqual(['row', 'debit', 'gateway']);
  });

  // The caller hands the service a POSITIVE amount and the payout's own
  // reference; `reason`, `floor: 0` and the ledger outcome are the service's to
  // set, so no caller can get them wrong. The full account number goes down
  // (the service stores last-4 on the ledger row).
  it('routes the debit through withdrawForCashout with the wd: anchor', async () => {
    const h = harness();
    await start(h);
    expect(h.packs.withdrawForCashout).toHaveBeenCalledTimes(1);
    expect(h.packs.withdrawForCashout).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        amount: 50,
        bankCode: 'MBB',
        accountNumber: '1234567890',
        idempotencyReference: expect.stringMatching(/^wd:/),
      }),
    );
    // The reference the row was written under is the one the debit records.
    const call = h.packs.withdrawForCashout.mock.calls[0][0];
    expect(call.merchantTransactionId).toBe(
      h.packs.createGlobePayWithdrawals.mock.calls[0][0][0]
        .merchant_transaction_id,
    );
  });

  it('REFUNDS the debit and closes the row when the gateway DEFINITELY refuses', async () => {
    const h = harness();
    // definite: a parsed isSuccess:false response — no payout exists there.
    submitMock.mockRejectedValue(
      new GlobePayError('nope', ['PMT10013'], 200, true),
    );
    await expect(start(h)).rejects.toThrow(/could not start your withdrawal/i);

    // The debit went through withdrawForCashout, so the ONLY
    // withdrawCreditsWithLedger call left on this path is the refund: positive
    // amount, wd-refund: anchor.
    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);
    expect(h.packs.withdrawCreditsWithLedger.mock.calls[0][0]).toMatchObject({
      customerId: 'cus_1',
      amount: 50,
      reason: 'cashout',
    });
    expect(
      h.packs.withdrawCreditsWithLedger.mock.calls[0][0].idempotencyReference,
    ).toMatch(/^wd-refund:/);
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      id: 'gpw_1',
      status: 'failed',
    });
  });

  // The classic double-payout window: the request reached the gateway and
  // only the RESPONSE was lost. Refunding here + the payout executing =
  // customer paid twice. The row must stay pending for the sweep.
  it.each([
    ['a timeout', new Error('The operation was aborted due to timeout')],
    ['a WAF/non-JSON page', new GlobePayError('non-JSON response', [], 503)],
  ])(
    'does NOT refund on %s — ambiguous outcome stays pending for the sweep',
    async (_label, error) => {
      const h = harness();
      submitMock.mockRejectedValue(error);
      const result = await start(h);
      // Ambiguity is not an error to the caller: the debit stands and the
      // sweep resolves the payout, exactly like a slow-processing one.
      expect(result.transactionId).toBeNull();
      // The debit stands (one withdrawForCashout) and NO refund is written.
      expect(h.packs.withdrawForCashout).toHaveBeenCalledTimes(1);
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
      // The row is NOT closed — the sweep must still be able to claim it.
      expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
      expect(h.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('AMBIGUOUS'),
      );
    },
  );

  // BEHAVIOUR CHANGE, deliberate: the gate now runs inside the service, which
  // is called AFTER the row is written (the row must exist before the gateway
  // call — the callback echoes only MerchantTransactionId). So a gate refusal
  // leaves a `failed` row where it previously left none. That is the same
  // terminal shape an insufficient-balance debit has always produced, and the
  // sweep only ever chases `pending` rows.
  it('a gate refusal closes the row and never reaches the gateway', async () => {
    const h = harness();
    h.packs.withdrawForCashout.mockRejectedValue(
      new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'RM 60.00 of your deposits must be spent on packs before you can withdraw.',
      ),
    );
    await expect(start(h)).rejects.toThrow(
      /RM 60\.00 of your deposits must be spent on packs/,
    );
    expect(h.packs.createGlobePayWithdrawals).toHaveBeenCalledTimes(1);
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      id: 'gpw_1',
      status: 'failed',
    });
    // No money moved and nothing was refunded (there was no debit to refund).
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('closes the row WITHOUT refunding when the debit itself fails (insufficient balance)', async () => {
    const h = harness();
    h.packs.withdrawForCashout.mockRejectedValue(
      new Error('Insufficient credits'),
    );
    await expect(start(h)).rejects.toThrow(/insufficient/i);
    // Nothing was debited, so nothing to refund.
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      id: 'gpw_1',
      status: 'failed',
    });
  });

  it('stamps their W… id on the row after a successful submit', async () => {
    const h = harness();
    const result = await start(h);
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      id: 'gpw_1',
      gateway_transaction_id: 'W2026072200000001',
    });
    expect(result.transactionId).toBe('W2026072200000001');
    expect(result.balance).toBe(50);
  });

  it.each([49, 50001])(
    'rejects RM %s — outside the payout band — before any row or debit',
    async (amount) => {
      const h = harness();
      await expect(start(h, { amount })).rejects.toThrow(
        /between RM 50 and RM 50,000/,
      );
      expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
      expect(h.packs.withdrawForCashout).not.toHaveBeenCalled();
    },
  );

  it('rejects bad bank details before any row or debit', async () => {
    const h = harness();
    await expect(start(h, { accountNumber: 'abc' })).rejects.toThrow(
      /account number/i,
    );
    expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.packs.withdrawForCashout).not.toHaveBeenCalled();
  });

  it('refuses to run when withdrawals are not enabled', async () => {
    process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'false';
    const h = harness();
    await expect(start(h)).rejects.toThrow(/not open yet/i);
    expect(h.packs.withdrawForCashout).not.toHaveBeenCalled();
  });
});

/**
 * PacksModuleService.withdrawForCashout — the gate + debit as ONE serialized
 * unit (plan 082).
 *
 * SCOPE OF WHAT THESE PIN: the same fake-`this` technique as
 * delivery-transition-atomic.unit.spec.ts — @InjectTransactionManager reuses a
 * provided sharedContext.transactionManager and calls the original method, so
 * the real body runs against a fake `em`. That pins the LOCK-THEN-READ-THEN-
 * DEBIT WIRING: the advisory lock is taken first, and the gate read and the
 * debit both ride the transaction it was taken on.
 *
 * It does NOT observe a race. No test here runs two concurrent transactions;
 * there is no DB, so `pg_advisory_xact_lock` is a recorded string, not a lock.
 * The regression it guards is therefore structural — if a future edit moves the
 * walletSummary read back outside the lock, or drops the shared context so the
 * debit opens its own transaction, these fail. Actual serialization is a
 * Postgres property of the shipped SQL.
 */
const fakeWallet = (over: Record<string, unknown> = {}) => ({
  balance: 1000,
  available: 1000,
  locked: 0,
  isFrozen: false,
  nextUnlock: null,
  withdrawable: 1000,
  playthrough: { deposited: 0, used: 0, remaining: 0 },
  ...over,
});

/**
 * @param windowCents what the rolling-24h cap SUM returns (prior pending +
 *   settled rows, EXCLUDING the just-created one — the real query filters it
 *   out by merchant_transaction_id).
 */
const fakeService = (wallet = fakeWallet(), windowCents = 0) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const em = {
    execute: jest.fn(async (q: string, _params?: unknown[]) =>
      q.includes('globepay_withdrawal')
        ? [{ sum_cents: String(windowCents) }]
        : [],
    ),
  };
  // Parameters are declared (not inferred away) so the call-argument
  // assertions below — which are the whole point of this harness — can index
  // mock.calls[n][1] / [2] under `strict`.
  const walletSummary = jest.fn(
    async (
      _customerId: string,
      _precomputed?: unknown,
      _ctx?: { transactionManager: unknown },
    ) => wallet,
  );
  const withdrawCreditsWithLedger = jest.fn(
    async (
      _input: { ledger: Record<string, unknown> },
      _ctx?: { transactionManager: unknown },
    ) => ({
      id: 'ct_1',
      balance: 950,
      amount: -50,
      replayed: false,
      reference: null,
    }),
  );
  Object.assign(svc, { walletSummary, withdrawCreditsWithLedger });
  const ctx = { transactionManager: em } as never;
  return { svc, em, ctx, walletSummary, withdrawCreditsWithLedger };
};

const cashout = {
  customerId: 'cus_1',
  amount: 50,
  merchantTransactionId: 'PC-abc',
  idempotencyReference: 'wd:deadbeef',
  bankCode: 'MBB',
  accountNumber: '1234567890',
};

describe('PacksModuleService.withdrawForCashout', () => {
  beforeEach(() => {
    delete process.env.GLOBEPAY_WD_DAILY_MAX_RM;
  });

  it('takes the credit: advisory lock BEFORE reading the gate', async () => {
    const f = fakeService();
    await f.svc.withdrawForCashout(cashout, f.ctx);
    expect(f.em.execute.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(f.em.execute.mock.calls[0][1]).toEqual(['credit:cus_1']);
    // The gate read must not have happened before the lock landed.
    expect(f.walletSummary).toHaveBeenCalledTimes(1);
    expect(f.em.execute.mock.invocationCallOrder[0]).toBeLessThan(
      f.walletSummary.mock.invocationCallOrder[0],
    );
  });

  // THE REGRESSION GUARD for the unlocked check-then-debit window. Both halves
  // must ride the SAME transaction the lock was taken on; identity (toBe), not
  // structural equality, is the assertion that can actually fail if a future
  // edit drops the context and lets the debit open its own connection.
  it('gate read and debit share the transaction the lock was taken on', async () => {
    const f = fakeService();
    await f.svc.withdrawForCashout(cashout, f.ctx);
    const gateCtx = f.walletSummary.mock.calls[0][2];
    const debitCtx = f.withdrawCreditsWithLedger.mock.calls[0][1];
    expect(gateCtx?.transactionManager).toBe(f.em);
    expect(debitCtx?.transactionManager).toBe(f.em);
    expect(debitCtx?.transactionManager).toBe(gateCtx?.transactionManager);
    // walletSummary is called with no precomputed scalars, so it re-scans the
    // ledger under the lock rather than trusting a pre-lock read.
    expect(f.walletSummary.mock.calls[0][1]).toBeUndefined();
  });

  it('sets reason, floor 0 and the requested WD payload itself', async () => {
    const f = fakeService();
    const result = await f.svc.withdrawForCashout(cashout, f.ctx);
    expect(f.withdrawCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        // Positive RM in, negative delta out.
        amount: -50,
        reason: 'cashout',
        floor: 0,
        reference: 'PC-abc',
        idempotencyReference: 'wd:deadbeef',
      }),
      expect.anything(),
    );
    expect(f.withdrawCreditsWithLedger.mock.calls[0][0].ledger).toMatchObject({
      outcome: 'requested',
      bankCode: 'MBB',
      accountNumber: '1234567890',
      gatewayRef: 'PC-abc',
    });
    expect(result.balance).toBe(950);
  });

  it('blocks a frozen account entirely — no debit', async () => {
    const f = fakeService(fakeWallet({ isFrozen: true, available: 0, withdrawable: 0 }));
    await expect(f.svc.withdrawForCashout(cashout, f.ctx)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/under review/i),
    });
    expect(f.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('blocks on the playthrough gate — no debit', async () => {
    const f = fakeService(
      fakeWallet({
        withdrawable: 0,
        playthrough: { deposited: 100, used: 40, remaining: 60 },
      }),
    );
    await expect(f.svc.withdrawForCashout(cashout, f.ctx)).rejects.toThrow(
      /RM 60\.00 of your deposits must be spent on packs/,
    );
    expect(f.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });

  // The case floor 0 CANNOT catch: raw balance 1000 is plenty, but 960 of it is
  // locked commission. This is the whole reason the gate must be under the lock.
  it('caps at withdrawable when locked commissions shrink it below the balance', async () => {
    const f = fakeService(
      fakeWallet({ available: 40, locked: 960, withdrawable: 40 }),
    );
    await expect(f.svc.withdrawForCashout(cashout, f.ctx)).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: expect.stringMatching(/withdraw up to RM 40\.00 right now/),
    });
    expect(f.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('succeeds when under both the gate and the daily cap', async () => {
    const f = fakeService(fakeWallet(), 100_00);
    await expect(
      f.svc.withdrawForCashout(cashout, f.ctx),
    ).resolves.toMatchObject({ id: 'ct_1' });
    expect(f.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);
  });

  it('refuses past the rolling-24h cap, naming the remaining headroom', async () => {
    // 49,980 already withdrawn today; a 50 RM payout would reach 50,030 > 50,000.
    const f = fakeService(fakeWallet(), 49_980_00);
    await expect(f.svc.withdrawForCashout(cashout, f.ctx)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: 'Daily withdrawal limit reached. You can withdraw RM 20.00 more today.',
    });
    expect(f.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('never quotes negative headroom when the window already exceeds the cap', async () => {
    const f = fakeService(fakeWallet(), 60_000_00);
    await expect(f.svc.withdrawForCashout(cashout, f.ctx)).rejects.toThrow(
      /You can withdraw RM 0\.00 more today\./,
    );
  });

  it('honours GLOBEPAY_WD_DAILY_MAX_RM, read per call', async () => {
    const f = fakeService(fakeWallet(), 0);
    process.env.GLOBEPAY_WD_DAILY_MAX_RM = '40';
    // 50 > 40 with an empty window — only a per-call env read can see this,
    // since the module was imported long before this assignment.
    await expect(f.svc.withdrawForCashout(cashout, f.ctx)).rejects.toThrow(
      /Daily withdrawal limit reached\. You can withdraw RM 40\.00 more today\./,
    );
  });

  // The cap query is the only thing standing between a compromised account and
  // the whole balance, so its WHERE clause is pinned literally: `failed` rows
  // never count (that money came back), and the row this very attempt just
  // wrote as `pending` is excluded by merchant_transaction_id — without that
  // exclusion the attempt would be counted against its own cap.
  it('counts only pending+settled in the last 24h, excluding this attempt', async () => {
    const f = fakeService();
    await f.svc.withdrawForCashout(cashout, f.ctx);
    const [sql, params] = f.em.execute.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('globepay_withdrawal');
    expect(sql).toContain("status IN ('pending', 'settled')");
    expect(sql).not.toContain('failed');
    expect(sql).toContain("created_at > now() - interval '24 hours'");
    expect(sql).toContain('merchant_transaction_id <> ?');
    expect(params).toEqual(['cus_1', 'PC-abc']);
  });

  // Self-exclusion, proven by behaviour rather than by SQL text: the ONLY row
  // in the window is this attempt's own pending row, so the sum the query sees
  // is 0 and a full-ceiling withdrawal must succeed. If the exclusion were
  // dropped, the sum would be 50,000 and this would refuse.
  it('a withdrawal at the full ceiling succeeds when its own row is the only one', async () => {
    const f = fakeService(fakeWallet({ withdrawable: 50_000 }), 0);
    await expect(
      f.svc.withdrawForCashout({ ...cashout, amount: 50_000 }, f.ctx),
    ).resolves.toBeDefined();
    expect(f.withdrawCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ amount: -50_000 }),
      expect.anything(),
    );
  });

  // This method inverts the caller's sign convention, so a caller that passed
  // an already-negated amount would CREDIT the customer. Fail loud, before the
  // lock and before any read.
  it.each([0, -50, Number.NaN])('refuses a non-positive amount (%p)', async (amount) => {
    const f = fakeService();
    await expect(
      f.svc.withdrawForCashout({ ...cashout, amount }, f.ctx),
    ).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA });
    expect(f.em.execute).not.toHaveBeenCalled();
    expect(f.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });
});

describe('POST /store/credits/withdraw — actor_id guard', () => {
  it('401s a register-phase token (actor_id "") without starting a withdrawal', async () => {
    process.env.GLOBEPAY_WITHDRAW_NOTIFY_URL = 'https://us/notify-wd';
    process.env.GLOBEPAY_PAYOUT_VERIFY_URL = 'https://us/payout-verify';
    const resolve = jest.fn();
    const json = jest.fn();
    const req = {
      auth_context: { actor_id: '' },
      // A FULLY VALID body with withdrawals enabled, so the guard is the only
      // possible source of UNAUTHORIZED — every other rejection on this path
      // has a different type and message.
      body: {
        amount: 50,
        bank_code: 'MBB',
        account_number: '1234567890',
        account_holder_name: 'AHMAD BIN ALI',
      },
      headers: {},
      ip: '1.2.3.4',
      scope: { resolve },
    } as never;
    await expect(withdrawRoute(req, { json } as never)).rejects.toMatchObject({
      type: MedusaError.Types.UNAUTHORIZED,
    });
    // startGlobePayWithdrawal resolves the packs module before it touches the
    // ledger, so an untouched `resolve` is the proxy for "never called".
    expect(resolve).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});

describe('withdrawal reconcile decisions', () => {
  it('settles on success, refunds on failure, waits otherwise', () => {
    expect(withdrawalReconcileAction('success')).toEqual({ kind: 'settle' });
    expect(withdrawalReconcileAction('failed')).toEqual({ kind: 'refund' });
    expect(withdrawalReconcileAction('pending')).toEqual({ kind: 'wait' });
  });

  it('refunds an unknown payout only once it is too old for an in-flight submit', () => {
    const created = new Date('2026-07-22T10:00:00Z');
    expect(
      unknownWithdrawalAction(created, new Date('2026-07-22T10:30:00Z'), false),
    ).toEqual({ kind: 'wait' });
    expect(
      unknownWithdrawalAction(created, new Date('2026-07-22T11:30:00Z'), false),
    ).toEqual({ kind: 'refund' });
  });

  it('NEVER unknown-refunds a payout that has a gateway id, however stale — a 400 there is our config, not non-existence', () => {
    const created = new Date('2026-07-22T10:00:00Z');
    expect(
      unknownWithdrawalAction(created, new Date('2026-07-29T10:00:00Z'), true),
    ).toEqual({ kind: 'wait' });
  });
});
