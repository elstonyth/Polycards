import { MedusaError } from '@medusajs/framework/utils';
import {
  GLOBEPAY_WD_MIN_RM,
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
import { savedBankAccountId } from '../saved-accounts';
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

/** The destination the customer saved two days ago — past its cooling-off
 *  window, so it is the "happy path" account every ordering test pays to. The
 *  bank code and number live HERE, in the saved list, and nowhere in a request:
 *  that is the whole point of plan 088. */
const SAVED_ACCOUNT = {
  id: savedBankAccountId('MBB', '1234567890'),
  bankCode: 'MBB',
  bankName: 'Maybank',
  accountNumber: '1234567890',
  accountHolderName: 'AHMAD BIN ALI',
  savedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
};

function harness(savedAccounts: unknown[] = [SAVED_ACCOUNT]) {
  const packs = {
    // The unlocked precheck's list read. The AUTHORITATIVE one is inside
    // withdrawForCashout, on that method's own transaction manager — see the
    // service describe below, which runs the real SQL against a fake `em`.
    savedBankAccountsFor: jest.fn().mockResolvedValue(savedAccounts),
    createGlobePayWithdrawals: jest.fn().mockResolvedValue([{ id: 'gpw_1' }]),
    // Idempotency-Key replay lookup. Empty by default — no prior intent.
    listGlobePayWithdrawals: jest.fn().mockResolvedValue([]),
    creditBalance: jest.fn().mockResolvedValue(50),
    updateGlobePayWithdrawals: jest.fn().mockResolvedValue(undefined),
    // The gate + debit unit. Everything the old caller-side policy check did
    // (freeze, locked commissions, playthrough, the daily cap) now happens
    // INSIDE this one service call, under the credit: advisory lock — see the
    // `PacksModuleService.withdrawForCashout` describe below, which exercises
    // the real thing against a fake `this`. Here it is stubbed, because these
    // tests own the MONEY ORDERING (row -> debit -> gateway, refund on refusal).
    // Returns the destination it RESOLVED under the lock — the only thing the
    // caller is allowed to submit to the gateway.
    withdrawForCashout: jest.fn().mockResolvedValue({
      id: 'ct_1',
      balance: 50,
      amount: -50,
      replayed: false,
      reference: null,
      destination: SAVED_ACCOUNT,
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
    // Read by the PRECHECK only (unlocked, pre-row). The gate that decides is
    // withdrawForCashout's own re-read under the lock — stubbed above.
    // Defaults to fully open, so the precheck passes and the tests below
    // exercise the ordering rather than the refusal path.
    walletSummary: jest.fn().mockResolvedValue({
      balance: 1000,
      available: 1000,
      locked: 0,
      isFrozen: false,
      nextUnlock: null,
      withdrawable: 1000,
      playthrough: { deposited: 0, used: 0, remaining: 0 },
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
  // The ONLY thing a caller may say about the destination.
  accountId: SAVED_ACCOUNT.id,
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
    expect(withdrawalDetailsError(SAVED_ACCOUNT)).toBeNull();
  });
  it.each([
    [{ ...SAVED_ACCOUNT, bankCode: '' }, /bank/i],
    [{ ...SAVED_ACCOUNT, bankCode: 'not a code!' }, /bank/i],
    [{ ...SAVED_ACCOUNT, accountNumber: '12ab' }, /account number/i],
    [{ ...SAVED_ACCOUNT, accountNumber: '12345' }, /account number/i],
    [{ ...SAVED_ACCOUNT, accountHolderName: ' ' }, /holder name/i],
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
      return {
        id: 'ct_1',
        balance: 0,
        amount: -50,
        replayed: false,
        destination: SAVED_ACCOUNT,
      };
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

  // The caller hands the service a POSITIVE amount, the payout's own reference
  // and the ACCOUNT ID — never bank details; `reason`, `floor: 0` and the ledger
  // outcome are the service's to set, so no caller can get them wrong.
  it('routes the debit through withdrawForCashout with the wd: anchor', async () => {
    const h = harness();
    await start(h);
    expect(h.packs.withdrawForCashout).toHaveBeenCalledTimes(1);
    expect(h.packs.withdrawForCashout).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        amount: 50,
        accountId: SAVED_ACCOUNT.id,
        idempotencyReference: expect.stringMatching(/^wd:/),
      }),
    );
    // No bank detail is handed down: the service looks them up itself.
    const call = h.packs.withdrawForCashout.mock.calls[0][0];
    expect(call.bankCode).toBeUndefined();
    expect(call.accountNumber).toBeUndefined();
    // The reference the row was written under is the one the debit records.
    expect(call.merchantTransactionId).toBe(
      h.packs.createGlobePayWithdrawals.mock.calls[0][0][0]
        .merchant_transaction_id,
    );
  });

  // THE binding, end to end: the gateway is told to pay what the LOCKED
  // resolution returned. The precheck's copy is deliberately made to disagree
  // here — if a future edit submits the precheck's destination (or anything
  // from the caller) instead, this fails.
  it('submits the destination the LOCKED resolution returned', async () => {
    const h = harness();
    const lockedDestination = {
      ...SAVED_ACCOUNT,
      bankCode: 'CIMB',
      accountNumber: '9999999999',
      accountHolderName: '  SITI BINTI OMAR  ',
    };
    h.packs.withdrawForCashout.mockResolvedValue({
      id: 'ct_1',
      balance: 50,
      amount: -50,
      replayed: false,
      destination: lockedDestination,
    });
    await start(h);
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0][0]).toMatchObject({
      destinationBankCode: 'CIMB',
      destinationAccountNumber: '9999999999',
      destinationAccountHolderName: 'SITI BINTI OMAR',
    });
  });

  // Test-plan case 1: the gateway receives the STORED details for an account
  // the session owns, and the customer never said what they were.
  it('pays a saved, cooled-off account with its STORED details', async () => {
    const h = harness();
    const result = await start(h);
    expect(submitMock.mock.calls[0][0]).toMatchObject({
      merchantClientId: 'cus_1',
      destinationBankCode: SAVED_ACCOUNT.bankCode,
      destinationAccountNumber: SAVED_ACCOUNT.accountNumber,
      destinationAccountHolderName: SAVED_ACCOUNT.accountHolderName,
    });
    expect(result.transactionId).toBe('W2026072200000001');
  });

  // Test-plan case 4: the OLD contract must be GONE, not merely unused. Bank
  // details in the body with no id name no saved account, so this is the same
  // refusal an unknown id gets — and nothing is written or debited.
  it('refuses a body carrying bank details and no account id', async () => {
    const h = harness();
    await expect(
      startGlobePayWithdrawal(
        h.scope,
        {
          customerId: 'cus_1',
          amount: 50,
          accountId: undefined,
          ipAddress: '1.2.3.4',
          // The pre-088 body shape, passed through as excess properties.
          ...{
            bankCode: 'MBB',
            accountNumber: '1234567890',
            accountHolderName: 'AHMAD BIN ALI',
          },
        } as never,
        'https://us/notify-wd',
        'https://us/payout-verify',
      ),
    ).rejects.toThrow(/select a saved bank account/i);
    expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
    // calls.length, not not.toHaveBeenCalled(): a failure here would
    // pretty-print the recorded arguments, and those carry a full account
    // number on this path.
    expect(h.packs.withdrawForCashout.mock.calls.length).toBe(0);
    expect(submitMock.mock.calls.length).toBe(0);
  });

  // Test-plan case 2 at the CALLER level (the authoritative one is under the
  // lock, in the service describe below): an id that is not in this customer's
  // own list is refused before a row exists.
  it('refuses an account id the session does not own — no row, no debit', async () => {
    const h = harness();
    await expect(start(h, { accountId: 'acc_someone_else' })).rejects.toThrow(
      /select a saved bank account/i,
    );
    expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.packs.withdrawForCashout.mock.calls.length).toBe(0);
  });

  // Test-plan case 3.
  it("refuses a bank the active gateway cannot pay to BEFORE any debit, in the customer's words", async () => {
    // The saved account is a legacy GlobePay-coded row ('MBB' is not in the
    // registry); GlobePay passes it through, TGPay has no code for it.
    // The gateway's config is read before the precheck, so give the spec
    // a TGPay config of its own rather than borrowing the developer's env.
    const saved = {
      TGPAY_API_BASE: process.env.TGPAY_API_BASE,
      TGPAY_PUBLIC_KEY: process.env.TGPAY_PUBLIC_KEY,
      TGPAY_SECRET_KEY: process.env.TGPAY_SECRET_KEY,
    };
    process.env.TGPAY_API_BASE = 'https://sandbox-api.example.test/api/v2';
    process.env.TGPAY_PUBLIC_KEY = 'pk-test';
    process.env.TGPAY_SECRET_KEY = 'sk-test';
    try {
      const h = harness([SAVED_ACCOUNT]);
      await expect(start(h, { gateway: 'tgpay' })).rejects.toThrow(
        /not available with the current payout provider/i,
      );
      expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
      expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
      expect(h.packs.withdrawForCashout.mock.calls.length).toBe(0);
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();

      // Same fence for the recipient email TGPay needs: a payable bank but
      // no email is refused before any row or debit, not after.
      const payable = {
        ...SAVED_ACCOUNT,
        id: savedBankAccountId('MBBEMYKL', '1234567890'),
        bankCode: 'MBBEMYKL',
      };
      const h2 = harness([payable]);
      await expect(
        start(h2, { gateway: 'tgpay', email: '', accountId: payable.id }),
      ).rejects.toThrow(/email address/i);
      expect(h2.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
      expect(h2.packs.withdrawForCashout.mock.calls.length).toBe(0);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('refuses an account still inside the cooling-off window', async () => {
    const h = harness([
      {
        ...SAVED_ACCOUNT,
        savedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);
    await expect(start(h)).rejects.toThrow(
      /not available for withdrawals yet/i,
    );
    expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.packs.withdrawForCashout.mock.calls.length).toBe(0);
  });

  // Test-plan case 5: a pre-cooling-off row (no savedAt) is NOT usable, and it
  // says so in its own words — "wait a while" would be a lie, because waiting
  // never arms it.
  it('refuses an account with no savedAt, telling them to re-save it', async () => {
    const { savedAt: _dropped, ...noTimestamp } = SAVED_ACCOUNT;
    const h = harness([noTimestamp]);
    await expect(start(h)).rejects.toThrow(/remove it and save it again/i);
    expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.packs.withdrawForCashout.mock.calls.length).toBe(0);
  });

  it('honours PAYOUT_DESTINATION_COOLDOWN_HOURS, read per call', async () => {
    const twoHoursOld = [
      {
        ...SAVED_ACCOUNT,
        savedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    ];
    // 2h old: refused under the 24h default…
    await expect(start(harness(twoHoursOld))).rejects.toThrow(
      /not available for withdrawals yet/i,
    );
    // …and allowed once the operator shortens the window. Only a per-call env
    // read can see this — the module was imported long before this assignment.
    process.env.PAYOUT_DESTINATION_COOLDOWN_HOURS = '1';
    try {
      await expect(start(harness(twoHoursOld))).resolves.toBeDefined();
    } finally {
      delete process.env.PAYOUT_DESTINATION_COOLDOWN_HOURS;
    }
  });

  it('REFUNDS the debit and closes the row when the gateway DEFINITELY refuses', async () => {
    const h = harness();
    // definite: a parsed isSuccess:false response — no payout exists there.
    submitMock.mockRejectedValue(
      new GlobePayError('nope', ['PMT10013'], 200, true),
    );
    await expect(start(h)).rejects.toThrow(/refused by the payment provider/i);

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
    // The close carries the reason with it, on ONE write (plan 095): the log
    // line below says the same thing but does not survive the next deployment,
    // and on 2026-08-11 that is exactly how eight production refusals ended up
    // unexplainable the following morning.
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      id: 'gpw_1',
      status: 'failed',
      failure_reason: expect.stringContaining('PMT10013'),
    });
    const [{ failure_reason: reason }] =
      h.packs.updateGlobePayWithdrawals.mock.calls[0];
    expect(reason).toMatch(/httpStatus=200/);
    expect(reason).toMatch(/bankCode=MBB/);
    // Same PII rule as the log: never the account number or the holder name.
    expect(reason).not.toMatch(/1234567890|AHMAD BIN ALI/i);

    // Their code is the ONLY record of why a payout was refused: the row keeps
    // no code, and a definite refusal leaves nothing at the gateway to requery.
    // Without this the customer sees "check the bank details" for a cause that
    // may have nothing to do with their bank (PMT10013 is an empty merchant
    // float) and nobody can tell which.
    const [logged] = h.logger.warn.mock.calls[0];
    expect(logged).toMatch(/PMT10013/);
    expect(logged).toMatch(/ref=/);
    // Every field the branch claims to log, asserted. Named individually rather
    // than as one big regex so a dropped field says WHICH one went missing.
    expect(logged).toMatch(/httpStatus=200/);
    expect(logged).toMatch(/definite=true/);
    expect(logged).toMatch(/amount=50/);
    // Diagnostic, not a data leak: bank code yes, the customer's account number
    // and holder name never.
    expect(logged).toMatch(/bankCode=MBB/);
    expect(logged).not.toMatch(/1234567890|AHMAD BIN ALI/i);
  });

  it('keeps a submitted account number out of the persisted reason', async () => {
    // `msg` is the gateway's own text — the one field of the reason we do not
    // compose — so it is the only one that can echo something we sent them.
    // The row's `account_number` is MASKED on the admin list (`••••1234`) and
    // revealed only one row at a time by ./[id]/account, so an unredacted
    // message would put the full number back on the list page through a column
    // nobody reads as PII. The log beside this write is a different audience
    // and stays unredacted, deliberately.
    const h = harness();
    submitMock.mockRejectedValue(
      new GlobePayError(
        'invalid beneficiary account 1234567890 for AHMAD BIN ALI',
        ['PMT10021'],
        200,
        true,
      ),
    );
    await expect(start(h)).rejects.toThrow(/refused by the payment provider/i);

    const [{ failure_reason: reason }] =
      h.packs.updateGlobePayWithdrawals.mock.calls[0];
    expect(reason).not.toMatch(/1234567890/);
    // The holder name carries no digits, so a digit-only rule left it whole.
    expect(reason).not.toMatch(/AHMAD BIN ALI/i);
    expect(reason).toMatch(/\[redacted\]/);
    // The diagnosis around the digits survives — redaction that ate the
    // sentence would defeat the column.
    expect(reason).toMatch(/invalid beneficiary account/);
    expect(reason).toMatch(/PMT10021/);
  });

  it('redacts an account number their message reformatted with separators', async () => {
    // `1234-5678-9012` is the same account as `123456789012`. The first
    // version of this redaction matched contiguous digits only, so a gateway
    // that pretty-printed the number back at us defeated it entirely.
    const h = harness();
    submitMock.mockRejectedValue(
      new GlobePayError(
        'beneficiary 1234-5678-9012 rejected by receiving bank',
        ['PMT10021'],
        200,
        true,
      ),
    );
    await expect(start(h)).rejects.toThrow(/refused by the payment provider/i);

    const [{ failure_reason: reason }] =
      h.packs.updateGlobePayWithdrawals.mock.calls[0];
    expect(reason).not.toMatch(/1234-5678-9012/);
    expect(reason).not.toMatch(/5678/);
    expect(reason).toMatch(/rejected by receiving bank/);
  });

  it('still refuses with the customer-facing message when the logger throws', async () => {
    // The log is diagnostics; the MedusaError is the customer's instruction.
    // A logger that throws must not be able to swap one for the other — before
    // the try/catch it escaped this branch and the caller saw the logger crash.
    const h = harness();
    h.logger.warn.mockImplementation(() => {
      throw new Error('logger exploded');
    });
    submitMock.mockRejectedValue(
      new GlobePayError('nope', ['PMT10013'], 200, true),
    );
    await expect(start(h)).rejects.toThrow(/refused by the payment provider/i);
    // Self-contained on purpose: without this the test would still pass if the
    // log were deleted outright, and the deletion is the regression it exists
    // to catch.
    expect(h.logger.warn).toHaveBeenCalled();
    // And the money path still completed: refund issued, row closed — with the
    // reason on it, which is what makes a thrown logger survivable at all now.
    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      id: 'gpw_1',
      status: 'failed',
      failure_reason: expect.stringContaining('PMT10013'),
    });
  });

  it('still leaves the row pending for the sweep when the AMBIGUOUS logger throws', async () => {
    // The costly one. This branch RETURNS rather than throws; a logger that
    // escapes turns it into a 500, and a customer whose balance is already gone
    // retries — debiting again and submitting a second payout that also
    // executes. The row must stay 'pending' and the call must still resolve.
    const h = harness();
    h.logger.error.mockImplementation(() => {
      throw new Error('logger exploded');
    });
    submitMock.mockRejectedValue(new Error('socket hang up'));
    await expect(start(h)).resolves.toMatchObject({ transactionId: null });
    expect(h.logger.error).toHaveBeenCalled();
    // No refund, and the row was never closed — the sweep still owns this one.
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalledWith({
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

  // The precheck's whole reason to exist: a refusal that is already certain
  // must not leave a `failed` row on the admin Withdrawals page (#384). It is
  // a fast path, not a control — the locked gate below still decides.
  it('a frozen account is refused BEFORE any row is written', async () => {
    const h = harness();
    h.packs.walletSummary.mockResolvedValue({
      balance: 1000,
      available: 0,
      locked: 0,
      isFrozen: true,
      nextUnlock: null,
      withdrawable: 0,
      playthrough: { deposited: 0, used: 0, remaining: 0 },
    });
    await expect(start(h)).rejects.toThrow(/under review/i);
    expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.packs.withdrawForCashout).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('a playthrough refusal also leaves no row behind', async () => {
    const h = harness();
    h.packs.walletSummary.mockResolvedValue({
      balance: 1000,
      available: 1000,
      locked: 0,
      isFrozen: false,
      nextUnlock: null,
      withdrawable: 0,
      playthrough: { deposited: 100, used: 40, remaining: 60 },
    });
    await expect(start(h)).rejects.toThrow(
      /RM 60\.00 of your deposits must be spent on packs/,
    );
    expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
  });

  // The RACE path, and the reason the precheck is not a control: the wallet was
  // open when the precheck read it (harness default) and closed by the time the
  // locked gate re-read it. The row already exists by then — it must be written
  // before the gateway call — so this refusal closes it as `failed`. Same
  // terminal shape an insufficient-balance debit has always produced, and the
  // sweep only ever chases `pending` rows.
  it('a LOCKED-gate refusal after the precheck passed closes the row', async () => {
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

  it('stamps their W… id on the row after a successful submit, scoped to pending', async () => {
    const h = harness();
    const result = await start(h);
    // Re-pointed, not relaxed: the old shape (`{id, gateway_transaction_id}`)
    // had no status guard at all. Scoped so a sweep that raced ahead and
    // closed the row while this submit was in flight cannot have a gateway
    // id written back onto it afterwards — same reasoning as the identical
    // scope on the admin approve route's own stamp for this field.
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      selector: { id: 'gpw_1', status: 'pending' },
      data: { gateway_transaction_id: 'W2026072200000001' },
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

  // Belt and braces on the STORED values: the saved-accounts route applies the
  // same check on save, so a stored account that fails it was written around
  // that route (or predates it). The gateway must not see it either way.
  it('rejects a SAVED account whose stored details are malformed', async () => {
    // The id is derived from the MUTATED number, so the row is INTERNALLY
    // CONSISTENT: resolveWithdrawalDestination's recompute passes it through
    // and withdrawalDetailsError is still what refuses it. Leave a stale id
    // here instead and the recompute refuses first — this case would go on
    // passing while covering none of globepay-withdrawal.ts:209.
    const malformed = {
      ...SAVED_ACCOUNT,
      accountNumber: 'abc',
      id: savedBankAccountId('MBB', 'abc'),
    };
    const h = harness([malformed]);
    await expect(start(h, { accountId: malformed.id })).rejects.toThrow(
      /account number/i,
    );
    expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.packs.withdrawForCashout.mock.calls.length).toBe(0);
  });

  it('refuses to run when withdrawals are not enabled', async () => {
    process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'false';
    const h = harness();
    await expect(start(h)).rejects.toThrow(/not open yet/i);
    expect(h.packs.withdrawForCashout).not.toHaveBeenCalled();
  });
});

describe('startGlobePayWithdrawal — approval threshold (held)', () => {
  afterEach(() => {
    delete process.env.GLOBEPAY_WD_APPROVAL_ABOVE_RM;
  });

  // Roomy enough that the precheck gate (amount <= withdrawable) never fires
  // on its own for these RM 1,000+ amounts — these cases are about the
  // approval threshold, not the withdrawable cap.
  const roomyWallet = {
    balance: 5000,
    available: 5000,
    locked: 0,
    isFrozen: false,
    nextUnlock: null,
    withdrawable: 5000,
    playthrough: { deposited: 0, used: 0, remaining: 0 },
  };

  it('RM 1,000.00 exactly still auto-submits — the boundary is strictly greater-than', async () => {
    const h = harness();
    h.packs.walletSummary.mockResolvedValue(roomyWallet);
    const result = await start(h, { amount: 1000 });
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('pending');
    expect(h.packs.createGlobePayWithdrawals.mock.calls[0][0][0].status).toBe(
      'pending',
    );
  });

  it('RM 1,000.01 is held: never reaches the gateway, but the debit still happens exactly as it does today', async () => {
    const h = harness();
    h.packs.walletSummary.mockResolvedValue(roomyWallet);
    const result = await start(h, { amount: 1000.01 });

    expect(submitMock).not.toHaveBeenCalled();
    expect(result.status).toBe('held');
    expect(result.transactionId).toBeNull();

    // Inserted with its FINAL status — never pending-then-flipped.
    expect(h.packs.createGlobePayWithdrawals.mock.calls[0][0][0].status).toBe(
      'held',
    );

    // The debit is unchanged for the held branch: same call, same shape as
    // the non-held path.
    expect(h.packs.withdrawForCashout).toHaveBeenCalledTimes(1);
    expect(h.packs.withdrawForCashout).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        amount: 1000.01,
        idempotencyReference: expect.stringMatching(/^wd:/),
      }),
    );
    expect(result.balance).toBe(50); // harness's fixed withdrawForCashout.balance

    // Never touched again after the insert: no gateway id stamped, no status
    // flip. A held row leaves ONLY via the admin approve/deny routes (task 5
    // — nothing consumes it yet).
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
  });

  it('GLOBEPAY_WD_APPROVAL_ABOVE_RM=2000, read per call, lifts an amount that would otherwise hold', async () => {
    process.env.GLOBEPAY_WD_APPROVAL_ABOVE_RM = '2000';
    const h = harness();
    h.packs.walletSummary.mockResolvedValue(roomyWallet);
    // Above the DEFAULT 1000 threshold, below the overridden 2000 — only a
    // per-call read (not a module-load-time latch) can see this, since the
    // module was imported long before this assignment.
    const result = await start(h, { amount: 1500 });
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('pending');
  });

  it('GLOBEPAY_WD_APPROVAL_ABOVE_RM=60 holds an amount the default 1000 threshold would auto-submit', async () => {
    // positiveIntFromEnv has no floor beyond "positive integer" — proved
    // empirically here rather than only by reading the helper.
    process.env.GLOBEPAY_WD_APPROVAL_ABOVE_RM = '60';
    const h = harness();
    h.packs.walletSummary.mockResolvedValue(roomyWallet);
    const result = await start(h, { amount: 100 });
    expect(submitMock).not.toHaveBeenCalled();
    expect(result.status).toBe('held');
  });

  it('GLOBEPAY_WD_APPROVAL_ABOVE_RM=0 holds ANY amount — the operator incident stop lever', async () => {
    // 0 is the "hold everything for a human" lever. A parser that rejects 0
    // and falls back to the 1000 default would let this RM-minimum amount
    // auto-submit — the exact silent-reopen failure this case exists to catch.
    // (Can't use RM 1 here: GLOBEPAY_WD_MIN_RM=50 rejects it before the
    // threshold check ever runs, so the smallest amount that reaches the
    // threshold check is the minimum itself.)
    process.env.GLOBEPAY_WD_APPROVAL_ABOVE_RM = '0';
    const h = harness();
    h.packs.walletSummary.mockResolvedValue(roomyWallet);
    const result = await start(h, { amount: GLOBEPAY_WD_MIN_RM });
    expect(submitMock).not.toHaveBeenCalled();
    expect(result.status).toBe('held');
  });

  it('a held-sized withdrawal is still refused BEFORE any row is written when frozen', async () => {
    const h = harness();
    h.packs.walletSummary.mockResolvedValue({
      ...roomyWallet,
      available: 0,
      isFrozen: true,
      withdrawable: 0,
    });
    await expect(start(h, { amount: 2000 })).rejects.toThrow(/under review/i);
    expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.packs.withdrawForCashout).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('a held-sized withdrawal is still refused BEFORE any row is written on a playthrough refusal', async () => {
    const h = harness();
    h.packs.walletSummary.mockResolvedValue({
      ...roomyWallet,
      withdrawable: 0,
      playthrough: { deposited: 100, used: 40, remaining: 60 },
    });
    await expect(start(h, { amount: 2000 })).rejects.toThrow(
      /RM 60\.00 of your deposits must be spent on packs/,
    );
    expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
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
 * @param windowCents what the rolling-24h cap SUM returns for PRIOR rows.
 * @param selfRowCents what the attempt's OWN just-created pending row is worth.
 *   The fake is params-aware on purpose: it hands back `windowCents` only when
 *   the query binds the exclusion parameter ($2 = this attempt's
 *   merchant_transaction_id), and `windowCents + selfRowCents` otherwise. So
 *   dropping `AND merchant_transaction_id <> ?` from the real SQL makes the
 *   self-exclusion test below genuinely fail, instead of passing on a mock that
 *   ignored its arguments.
 * @param heldCents a `held` row's worth, added to the sum ONLY when the real
 *   SQL's status list actually contains `'held'` — same trick as
 *   selfRowCents: it proves the WHERE clause drives the count, not the test
 *   wiring. Drop `'held'` from the real IN-list and a test relying on this
 *   stops summing it, instead of passing on a mock that always included it.
 * @param failedCents mirrors heldCents for `'failed'`, which the real SQL must
 *   never contain.
 */
const fakeService = (
  wallet = fakeWallet(),
  windowCents = 0,
  selfRowCents = 0,
  /**
   * The saved-account lists, BY CUSTOMER — the fake `customer` table.
   *
   * Keyed, and that is what keeps the cross-customer test below honest: `cus_2`
   * genuinely owns OTHER_CUSTOMERS_ACCOUNT, and the real method's
   * `SELECT metadata FROM customer WHERE id = ?` binds the TOKEN OWNER's id, so
   * asking for someone else's account while authenticated as `cus_1` really
   * does look it up in `cus_1`'s row and really does not find it. A fake that
   * ignored the bound id would make that test pass for free.
   */
  byCustomer: Record<string, unknown[]> = {
    cus_1: [SAVED_ACCOUNT],
    cus_2: [OTHER_CUSTOMERS_ACCOUNT],
  },
  heldCents = 0,
  failedCents = 0,
) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  /** The withdrawal row step 1a re-reads. Mutable so a test can close it
   *  (`f.row.status = 'failed'`) or delete it (`null`) without threading yet
   *  another positional argument through this helper. */
  const row: { status: string | null } = { status: 'held' };
  const em = {
    execute: jest.fn(async (q: string, params?: unknown[]) => {
      // The destination read. Runs on THIS manager — i.e. inside the same
      // transaction the advisory lock was taken on.
      if (q.includes('FROM customer')) {
        const id = params?.[0] as string;
        return byCustomer[id] === undefined
          ? [] // no such customer row
          : [{ metadata: { bank_accounts: byCustomer[id] } }];
      }
      // Step 1a's open-row re-read. Must be answered BEFORE the cap branch
      // below, which would otherwise swallow it — both statements name
      // globepay_withdrawal, so the discriminator is `SELECT status`, which
      // the aggregate cap query can never contain.
      if (q.includes('SELECT status')) {
        return row.status === null ? [] : [{ status: row.status }];
      }
      if (!q.includes('globepay_withdrawal')) return [];
      const excludesSelf = params?.[1] === cashout.merchantTransactionId;
      const base = excludesSelf ? windowCents : windowCents + selfRowCents;
      // Gated on the SQL text itself, not handed back unconditionally — see
      // the heldCents/failedCents jsdoc above.
      const held = q.includes("'held'") ? heldCents : 0;
      const failed = q.includes("'failed'") ? failedCents : 0;
      return [{ sum_cents: String(base + held + failed) }];
    }),
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
  return { svc, em, ctx, row, walletSummary, withdrawCreditsWithLedger };
};

/** Another customer's saved destination — see fakeService's `byCustomer`. */
const OTHER_CUSTOMERS_ACCOUNT = {
  id: savedBankAccountId('CIMB', '5555555555'),
  bankCode: 'CIMB',
  bankName: 'CIMB Bank',
  accountNumber: '5555555555',
  accountHolderName: 'SITI BINTI OMAR',
  savedAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
};

const cashout = {
  customerId: 'cus_1',
  amount: 50,
  merchantTransactionId: 'PC-abc',
  idempotencyReference: 'wd:deadbeef',
  accountId: SAVED_ACCOUNT.id,
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
    // The ledger records the RESOLVED destination — nothing about it came from
    // the call.
    expect(f.withdrawCreditsWithLedger.mock.calls[0][0].ledger).toMatchObject({
      outcome: 'requested',
      bankCode: SAVED_ACCOUNT.bankCode,
      accountNumber: SAVED_ACCOUNT.accountNumber,
      gatewayRef: 'PC-abc',
    });
    expect(result.balance).toBe(950);
    // And it hands that same destination back for the gateway call.
    expect(result.destination).toMatchObject({
      id: SAVED_ACCOUNT.id,
      bankCode: SAVED_ACCOUNT.bankCode,
      accountNumber: SAVED_ACCOUNT.accountNumber,
    });
  });

  // THE IDOR GUARD (test-plan case 2). `cus_2` really does own OTHER_CUSTOMERS_ACCOUNT —
  // fakeCustomers is keyed by customer id — so this is not passing because the
  // fixture has one customer or an empty list. The lookup happens in the
  // TOKEN OWNER's list, so someone else's id is simply not there.
  it("refuses another customer's account id — no debit", async () => {
    const f = fakeService();
    await expect(
      f.svc.withdrawForCashout(
        { ...cashout, accountId: OTHER_CUSTOMERS_ACCOUNT.id },
        f.ctx,
      ),
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: 'Select a saved bank account.',
    });
    // calls.length rather than not.toHaveBeenCalled(): a failing
    // not.toHaveBeenCalled() pretty-prints the recorded arguments, which on
    // this path carry a full bank account number.
    expect(f.withdrawCreditsWithLedger.mock.calls.length).toBe(0);
    // Proof the guard is ownership and not "that id does not exist anywhere":
    // the very same id resolves for the customer who owns it, off the same
    // fake customer table.
    const owner = fakeService();
    await expect(
      owner.svc.withdrawForCashout(
        {
          ...cashout,
          customerId: 'cus_2',
          accountId: OTHER_CUSTOMERS_ACCOUNT.id,
        },
        owner.ctx,
      ),
    ).resolves.toMatchObject({
      destination: expect.objectContaining({ id: OTHER_CUSTOMERS_ACCOUNT.id }),
    });
  });

  it('refuses an unknown account id — no debit', async () => {
    const f = fakeService();
    await expect(
      f.svc.withdrawForCashout({ ...cashout, accountId: 'acc_nope' }, f.ctx),
    ).rejects.toThrow('Select a saved bank account.');
    expect(f.withdrawCreditsWithLedger.mock.calls.length).toBe(0);
  });

  it('refuses an account still cooling off — no debit', async () => {
    const f = fakeService(fakeWallet(), 0, 0, {
      cus_1: [
        {
          ...SAVED_ACCOUNT,
          savedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        },
      ],
    });
    await expect(
      f.svc.withdrawForCashout(cashout, f.ctx),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/not available for withdrawals yet/i),
    });
    expect(f.withdrawCreditsWithLedger.mock.calls.length).toBe(0);
  });

  // Test-plan case 5, asserted at the gate that actually decides: a missing
  // timestamp resolves to REFUSED, with its own message. `undefined` never
  // means "usable".
  it('refuses an account with no savedAt — no debit, and says to re-save it', async () => {
    const { savedAt: _dropped, ...noTimestamp } = SAVED_ACCOUNT;
    const f = fakeService(fakeWallet(), 0, 0, { cus_1: [noTimestamp] });
    await expect(
      f.svc.withdrawForCashout(cashout, f.ctx),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/remove it and save it again/i),
    });
    expect(f.withdrawCreditsWithLedger.mock.calls.length).toBe(0);
  });

  // The destination must be pinned by the SAME serialized unit that debits: if
  // a future edit hoists the lookup out to the caller, or above the lock, it
  // can be swapped between check and debit.
  //
  // Both statements go through `em`, so this pins three things at once: the
  // destination read is the THIRD statement on the transaction the lock was
  // taken on (never before it, never on another connection), it binds the
  // TOKEN OWNER's id — the IDOR guard, in SQL — and it lands before the debit.
  it('reads the destination on the LOCKED transaction, after the lock and before the debit', async () => {
    const f = fakeService();
    await f.svc.withdrawForCashout(cashout, f.ctx);

    const [lockSql] = f.em.execute.mock.calls[0] as [string, unknown[]];
    const [openSql] = f.em.execute.mock.calls[1] as [string, unknown[]];
    const [readSql, readParams] = f.em.execute.mock.calls[2] as [
      string,
      unknown[],
    ];
    expect(lockSql).toContain('pg_advisory_xact_lock');
    expect(openSql).toContain('SELECT status');
    expect(readSql).toContain('FROM customer');
    expect(readParams).toEqual(['cus_1']);
    expect(f.em.execute.mock.invocationCallOrder[2]).toBeLessThan(
      f.withdrawCreditsWithLedger.mock.invocationCallOrder[0],
    );
  });

  /**
   * STEP 1a — the debit half of the pact with claimWithdrawalAgainstDebit.
   *
   * The admin approve/deny path closes an undebited held row under the
   * `credit:` advisory lock. That alone does not protect a debit QUEUED
   * BEHIND it on the same lock: the close cannot see a debit that has not run
   * yet, so without this re-read the debit would go on to commit against a
   * row the admin had just closed, and nothing would ever refund it (the
   * sweep selects 'pending' only).
   *
   * Same fake-`em` caveat as the rest of this describe: no lock is really
   * taken here, so what these pin is that the re-read happens ON the locked
   * transaction, BEFORE the debit, and that its answer is obeyed. The
   * exclusion itself is proven against a real Postgres in
   * withdrawal-claim.integration.spec.ts.
   */
  it('re-reads the row on the LOCKED transaction before doing anything else', async () => {
    const f = fakeService();
    await f.svc.withdrawForCashout(cashout, f.ctx);

    const [sql, params] = f.em.execute.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('SELECT status');
    expect(sql).toContain('FROM globepay_withdrawal');
    // By the payout's OWN reference, and soft-delete aware.
    expect(sql).toContain('merchant_transaction_id = ?');
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual(['PC-abc']);
    // After the lock, before the debit — the only placement that means
    // anything.
    expect(f.em.execute.mock.invocationCallOrder[0]).toBeLessThan(
      f.em.execute.mock.invocationCallOrder[1],
    );
    expect(f.em.execute.mock.invocationCallOrder[1]).toBeLessThan(
      f.withdrawCreditsWithLedger.mock.invocationCallOrder[0],
    );
  });

  it('refuses to debit a row an admin already closed — no debit, no destination read', async () => {
    const f = fakeService();
    f.row.status = 'failed';
    await expect(
      f.svc.withdrawForCashout(cashout, f.ctx),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message: expect.stringMatching(/no longer open/i),
    });
    expect(f.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    // Fails fast: the guard sits ahead of the destination lookup and the
    // gate, so a closed row costs one statement, not five.
    expect(f.walletSummary).not.toHaveBeenCalled();
    expect(
      f.em.execute.mock.calls.some(([q]) =>
        (q as string).includes('FROM customer'),
      ),
    ).toBe(false);
  });

  it('refuses when the row has vanished — a debit with nothing to resolve it', async () => {
    const f = fakeService();
    f.row.status = null;
    await expect(
      f.svc.withdrawForCashout(cashout, f.ctx),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
    expect(f.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });

  // 'pending' is the ordinary (below-threshold) payout, and it must still go
  // through: this guard is about CLOSED rows, not about held ones.
  it('debits a pending row exactly as it does a held one', async () => {
    const f = fakeService();
    f.row.status = 'pending';
    await expect(
      f.svc.withdrawForCashout(cashout, f.ctx),
    ).resolves.toMatchObject({ id: 'ct_1' });
    expect(f.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);
  });

  it('blocks a frozen account entirely — no debit', async () => {
    const f = fakeService(
      fakeWallet({ isFrozen: true, available: 0, withdrawable: 0 }),
    );
    await expect(
      f.svc.withdrawForCashout(cashout, f.ctx),
    ).rejects.toMatchObject({
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
    await expect(
      f.svc.withdrawForCashout(cashout, f.ctx),
    ).rejects.toMatchObject({
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
    await expect(
      f.svc.withdrawForCashout(cashout, f.ctx),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message:
        'Daily withdrawal limit reached. You can withdraw RM 20.00 more today.',
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
  // the whole balance, so its WHERE clause is pinned literally: `pending`,
  // `settled` and `held` rows all count — a held row already debited the
  // customer, so it consumes their blast radius exactly like a submitted one
  // — `failed` rows never count (that money came back), and the row this very
  // attempt just wrote as `pending` is excluded by merchant_transaction_id —
  // without that exclusion the attempt would be counted against its own cap.
  it('counts pending+settled+held in the last 24h, excluding this attempt and failed rows', async () => {
    const f = fakeService();
    await f.svc.withdrawForCashout(cashout, f.ctx);
    // Found by content, not by index: the statement order ahead of it (lock,
    // open-row re-read, destination read) is pinned by its own test above,
    // and hard-coding an index here would make this fail for an unrelated
    // reason. Matched on SUM( rather than the table name — step 1a's re-read
    // names globepay_withdrawal too and comes first.
    const [sql, params] = f.em.execute.mock.calls.find(([q]) =>
      (q as string).includes('SUM('),
    ) as [string, unknown[]];
    expect(sql).toContain('globepay_withdrawal');
    expect(sql).toContain("status IN ('pending', 'settled', 'held')");
    expect(sql).not.toContain('failed');
    expect(sql).toContain("created_at > now() - interval '24 hours'");
    expect(sql).toContain('merchant_transaction_id <> ?');
    expect(params).toEqual(['cus_1', 'PC-abc']);
  });

  // Behavioural companion to the SQL-content test above, proven through the
  // params-aware fake rather than a string match: RM 60 cap, a lone `held`
  // row worth RM 20 already in the window, plus this RM 50 attempt totals
  // RM 70 > RM 60. fakeService only hands back heldCents when the real WHERE
  // clause's status list actually says 'held' (see its jsdoc), so this fails
  // for the right reason — resolves instead of rejects — until the
  // production IN-list is widened. Without that, a customer could park an
  // unbounded queue of held payouts and blow straight past the 24h ceiling
  // the moment an operator approves them in a batch.
  it('an existing held row inside the window counts toward the cap, else batch-approving a queue of them blows past the 24h ceiling', async () => {
    process.env.GLOBEPAY_WD_DAILY_MAX_RM = '60';
    const f = fakeService(fakeWallet(), 0, 0, undefined, 20_00);
    await expect(
      f.svc.withdrawForCashout(cashout, f.ctx),
    ).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
      message:
        'Daily withdrawal limit reached. You can withdraw RM 40.00 more today.',
    });
    expect(f.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });

  // Mirror of the test above with the same RM 20 tagged `failed` instead of
  // `held`. fakeService only counts failedCents when the real SQL asks for
  // 'failed', which it never does, so this cannot go RED the way the held
  // test does — it is a forward-looking regression guard, not a driver: a
  // refused or refunded payout must never shrink the customer's next 24h, no
  // matter its size.
  it('a failed row inside the window never counts toward the cap', async () => {
    process.env.GLOBEPAY_WD_DAILY_MAX_RM = '60';
    const f = fakeService(fakeWallet(), 0, 0, undefined, 0, 20_00);
    await expect(
      f.svc.withdrawForCashout(cashout, f.ctx),
    ).resolves.toMatchObject({ id: 'ct_1' });
    expect(f.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);
  });

  // Self-exclusion, proven by BEHAVIOUR: the only row in the window is this
  // attempt's own pending row, worth the full ceiling. The params-aware fake
  // returns 0 only because the query binds the exclusion parameter — drop
  // `AND merchant_transaction_id <> ?` from the SQL and the fake returns
  // 50,000, which refuses. That is the bug this guards: without the exclusion
  // every withdrawal is counted against its own cap and anything above half the
  // ceiling refuses itself.
  it('a withdrawal at the full ceiling succeeds when its own row is the only one', async () => {
    const f = fakeService(fakeWallet({ withdrawable: 50_000 }), 0, 50_000_00);
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
  it.each([0, -50, Number.NaN])(
    'refuses a non-positive amount (%p)',
    async (amount) => {
      const f = fakeService();
      await expect(
        f.svc.withdrawForCashout({ ...cashout, amount }, f.ctx),
      ).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA });
      expect(f.em.execute).not.toHaveBeenCalled();
      expect(f.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    },
  );
});

/**
 * PacksModuleService.claimGlobePayWithdrawalStatus — the mutex behind both
 * admin routes (plan 094 Task 5).
 *
 * SCOPE, same as the withdrawForCashout describe above: the real method body
 * runs against a fake `em`, so what these pin is the SHAPE OF THE STATEMENT —
 * one conditional UPDATE with the accepted statuses in its WHERE clause, and
 * a RETURNING row as the answer to "did I win the claim". The mutex itself is
 * a Postgres property: a single-statement UPDATE re-evaluates its predicate
 * against committed state after the row lock releases, so of two concurrent
 * claims the loser matches zero rows. No test here runs two transactions.
 *
 * The regression this guards is the one the brief names explicitly: doing the
 * flip with updateGlobePayWithdrawals({ selector, data }) instead. That
 * type-checks and returns an array, but it is a find-then-write with no row
 * lock, so two concurrent approves both read 'held' and both submit — a
 * duplicate payout to a real bank account.
 */
describe('PacksModuleService.claimGlobePayWithdrawalStatus', () => {
  const fakeClaim = (returned: { id: string }[]) => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as PacksModuleService;
    // Parameters declared (not inferred away) so the call-argument assertions
    // below can index mock.calls[0][1] under `strict` — same reason as the
    // withdrawForCashout harness above.
    const em = {
      execute: jest.fn(async (_query: string, _params?: unknown[]) => returned),
    };
    return { svc, em, ctx: { transactionManager: em } as never };
  };

  it('claims with ONE conditional UPDATE, answered by RETURNING', async () => {
    const f = fakeClaim([{ id: 'gpw_1' }]);
    await expect(
      f.svc.claimGlobePayWithdrawalStatus(
        { id: 'gpw_1', from: ['held'], to: 'pending' },
        f.ctx,
      ),
    ).resolves.toBe(true);

    expect(f.em.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = f.em.execute.mock.calls[0];
    expect(sql).toMatch(/^UPDATE globepay_withdrawal/);
    expect(sql).toContain('SET status = ?');
    expect(sql).toContain('WHERE id = ?');
    // The whole point: the FROM-state is part of the predicate, so the write
    // and the check cannot be separated by another transaction.
    expect(sql).toContain('status IN (?)');
    expect(sql).toContain('deleted_at IS NULL');
    // Without RETURNING the caller could only learn "the row exists", never
    // "I am the one who moved it".
    expect(sql).toContain('RETURNING id');
    expect(params).toEqual(['pending', 'gpw_1', 'held']);
  });

  it('binds one placeholder per accepted status — never interpolated', async () => {
    const f = fakeClaim([{ id: 'gpw_1' }]);
    await f.svc.claimGlobePayWithdrawalStatus(
      { id: 'gpw_1', from: ['held', 'failed'], to: 'failed' },
      f.ctx,
    );
    const [sql, params] = f.em.execute.mock.calls[0];
    expect(sql).toContain('status IN (?, ?)');
    expect(sql).not.toContain("'held'");
    expect(params).toEqual(['failed', 'gpw_1', 'held', 'failed']);
  });

  it('a zero-row result is a LOST claim, not an error', async () => {
    const f = fakeClaim([]);
    await expect(
      f.svc.claimGlobePayWithdrawalStatus(
        { id: 'gpw_1', from: ['held'], to: 'pending' },
        f.ctx,
      ),
    ).resolves.toBe(false);
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

// One intent must produce ONE payout. Before the Idempotency-Key existed, every
// retry minted a fresh merchantTransactionId and therefore a second debit and a
// second payout — and the ambiguous-submit branch returns success on a gateway
// timeout, which is precisely when a client retries.
describe('startGlobePayWithdrawal — Idempotency-Key', () => {
  it('replays a prior withdrawal instead of debiting and submitting again', async () => {
    const h = harness();
    h.packs.listGlobePayWithdrawals.mockResolvedValue([
      {
        merchant_transaction_id: 'PC-prior',
        gateway_transaction_id: 'W2026081200000009',
        amount: 50,
      },
    ]);

    const res = await start(h, { idempotencyKey: 'retry-1' });

    expect(res.replayed).toBe(true);
    expect(res.merchantTransactionId).toBe('PC-prior');
    expect(res.transactionId).toBe('W2026081200000009');
    // The three things that must NOT happen twice.
    expect(h.packs.createGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.packs.withdrawForCashout).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  // Asserted as EXCLUDE-failed, not as a list of live statuses. An allowlist
  // here silently stops matching when a status is added — plan 094 added
  // 'held' and an enumerating read would have missed every withdrawal parked
  // for admin approval, minting a second one on retry.
  it('scopes the replay lookup to the customer, the key, and non-failed rows', async () => {
    const h = harness();
    await start(h, { idempotencyKey: 'retry-2' });

    expect(h.packs.listGlobePayWithdrawals).toHaveBeenCalledWith(
      {
        customer_id: 'cus_1',
        idempotency_key: 'retry-2',
        status: { $ne: 'failed' },
      },
      { take: 1 },
    );
  });

  // A failed attempt FREES the key. The row is written before the withdrawal
  // gate runs, so the common refusals — insufficient balance, playthrough not
  // met, the daily cap — would otherwise burn a key for a request that never
  // moved money, and the house convention is one key per INTENT reused across
  // error retries (TopUpSheet.tsx). Replaying it as a success would be worse
  // still: reporting a payout that is never coming.
  it('does not replay a FAILED prior attempt — the retry is a fresh withdrawal', async () => {
    const h = harness();
    // The status filter is what excludes it, so an honest mock returns nothing
    // for the scoped query the code now issues.
    h.packs.listGlobePayWithdrawals.mockResolvedValue([]);

    const res = await start(h, { idempotencyKey: 'retry-failed' });

    expect(res.replayed).toBeFalsy();
    // The retry must actually go through: new row, real debit, real submit.
    expect(h.packs.createGlobePayWithdrawals).toHaveBeenCalled();
    expect(h.packs.withdrawForCashout).toHaveBeenCalled();
    expect(submitMock).toHaveBeenCalled();
  });

  // Two requests with the same key can both pass the read before either
  // inserts — the read cannot close that window, only the partial unique index
  // can. The loser must come back as a replay of the winner's row, not a 500,
  // and critically: nothing has been debited at the point the insert fails.
  it('replays instead of 500ing when a concurrent insert wins the unique index', async () => {
    const h = harness();
    let seenPrior = false;
    // First read (pre-precheck) sees nothing; after the duplicate-key throw the
    // winner's row is visible. That is exactly the race ordering.
    h.packs.listGlobePayWithdrawals.mockImplementation(async () =>
      seenPrior
        ? [
            {
              merchant_transaction_id: 'PC-winner',
              gateway_transaction_id: 'W2026081200000042',
              amount: 50,
            },
          ]
        : [],
    );
    h.packs.createGlobePayWithdrawals.mockImplementation(async () => {
      seenPrior = true;
      throw Object.assign(
        new Error('duplicate key value violates unique constraint'),
        {
          code: '23505',
        },
      );
    });

    const res = await start(h, { idempotencyKey: 'raced' });

    expect(res.replayed).toBe(true);
    expect(res.merchantTransactionId).toBe('PC-winner');
    // The loser must not debit or submit — the winner owns the payout.
    expect(h.packs.withdrawForCashout).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  // A duplicate key with no visible active row means the winner failed and
  // freed the key between the two statements. Inventing a success there would
  // report a payout that does not exist.
  it('rethrows a duplicate key when no active row is visible', async () => {
    const h = harness();
    h.packs.listGlobePayWithdrawals.mockResolvedValue([]);
    h.packs.createGlobePayWithdrawals.mockRejectedValue(
      Object.assign(
        new Error('duplicate key value violates unique constraint'),
        {
          code: '23505',
        },
      ),
    );

    await expect(
      start(h, { idempotencyKey: 'raced-then-freed' }),
    ).rejects.toThrow(/duplicate key/i);
    expect(h.packs.withdrawForCashout).not.toHaveBeenCalled();
  });

  it('stores the key on the row so the next retry can find it', async () => {
    const h = harness();
    await start(h, { idempotencyKey: '  retry-3  ' });

    const row = (
      h.packs.createGlobePayWithdrawals.mock.calls[0][0] as Record<
        string,
        unknown
      >[]
    )[0];
    // Trimmed, so a client padding the header does not create a distinct key.
    expect(row.idempotency_key).toBe('retry-3');
  });

  it('treats a blank key as absent rather than as one shared key', async () => {
    const h = harness();
    await start(h, { idempotencyKey: '   ' });

    // No lookup, and the row records NULL — otherwise every keyless-but-blank
    // withdrawal would collide on a single shared token.
    expect(h.packs.listGlobePayWithdrawals).not.toHaveBeenCalled();
    const row = (
      h.packs.createGlobePayWithdrawals.mock.calls[0][0] as Record<
        string,
        unknown
      >[]
    )[0];
    expect(row.idempotency_key).toBeNull();
  });

  it('is unchanged for callers that send no key at all', async () => {
    const h = harness();
    const res = await start(h);

    expect(res.replayed).toBeUndefined();
    expect(h.packs.listGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.packs.createGlobePayWithdrawals).toHaveBeenCalled();
    expect(submitMock).toHaveBeenCalled();
  });
});
