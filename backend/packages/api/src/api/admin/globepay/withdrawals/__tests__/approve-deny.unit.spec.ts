import { MedusaError } from '@medusajs/framework/utils';

// The gateway's HTTP seam is the only thing stubbed — every decision under
// test is the routes' own. Same seam and same reason as the sweep spec.
jest.mock('../../../../../modules/packs/gateway', () => {
  const actual = jest.requireActual('../../../../../modules/packs/gateway');
  return { ...actual, submitWithdrawal: jest.fn() };
});
// The refund helper's steps 2 and 4. Mocked for the same reason the sweep
// spec mocks them: unmocked, sendWithdrawalReceipt's real body fails silently
// against a bare fake container, so nothing could assert on it.
jest.mock('../../../../../modules/packs/notify-feed', () => ({
  notifyFeed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../../modules/packs/withdrawal-receipt', () => ({
  sendWithdrawalReceipt: jest.fn().mockResolvedValue(true),
}));

import {
  GatewayError,
  submitWithdrawal,
} from '../../../../../modules/packs/gateway';
import { notifyFeed } from '../../../../../modules/packs/notify-feed';
import { sendWithdrawalReceipt } from '../../../../../modules/packs/withdrawal-receipt';
import {
  withdrawalIdempotencyReference,
  withdrawalRefundReference,
} from '../../../../../modules/packs/globepay-withdrawal';
import { POST as APPROVE } from '../[id]/approve/route';
import { POST as DENY } from '../[id]/deny/route';

const submitMock = submitWithdrawal as jest.Mock;
const notifyFeedMock = notifyFeed as jest.Mock;
const receipt = sendWithdrawalReceipt as jest.Mock;

const ACCOUNT_NUMBER = '1234567890';

/** A held row: debited, never submitted, no gateway id. `amount` is a STRING
 *  because the column is model.bigNumber() — the routes must coerce it before
 *  submitWithdrawal calls .toFixed(2) on it.
 *
 *  `created_at` is carried because the model has it and the reconcile job's
 *  staleness watch reads it. NEITHER ROUTE DOES: the row's age used to decide
 *  whether an undebited row could be closed, and that is now the `credit:`
 *  lock's job (packs.claimWithdrawalAgainstDebit), so no test here should
 *  ever need to vary it. */
const heldRow = () => ({
  id: 'gpw_1',
  merchant_transaction_id: 'PW-HELD-1',
  gateway_transaction_id: null as string | null,
  customer_id: 'cus_1',
  amount: '1500.00',
  bank_code: 'MBBEMYKL',
  gateway: 'tgpay',
  account_number: ACCOUNT_NUMBER,
  account_holder_name: 'AHMAD BIN ALI',
  status: 'held',
  gateway_status: null as number | null,
  failure_reason: null as string | null,
  created_at: new Date(Date.now() - 5 * 60 * 1000),
  settled_at: null,
});

/**
 * The claim fake is STATEFUL — without that, "double-approve submits once" is
 * vacuous. It models exactly what the real method does: decide whether a
 * debit exists, then flip the row only when its CURRENT status is one the
 * caller accepts, reporting whether this caller is the one that moved it. An
 * undebited row goes to 'failed' whatever `to` says, mirroring the service.
 *
 * It fails OPEN (returns claimed:true for an id it does not hold), the same
 * trick the sweep's held-row test uses: a route that stopped claiming the row
 * it is about to act on cannot pass by accident.
 *
 * What it cannot model is the LOCK — there is no database here. That the
 * debit read and the claim are one serialized unit is proven against a real
 * Postgres in modules/packs/__tests__/withdrawal-claim.integration.spec.ts.
 * What these tests own is that the routes route their decision through that
 * method at all, which is exactly what the unlocked version got wrong.
 */
function harness(row = heldRow(), debitExists = true, frozen = false) {
  const packs = {
    listGlobePayWithdrawals: jest.fn(async (selector: { id?: string }) =>
      selector.id === row.id ? [row] : [],
    ),
    // Present so the "no unlocked read" guard below can prove neither route
    // calls it any more; the locked service method owns this read now.
    listCreditTransactions: jest.fn(async () =>
      debitExists ? [{ id: 'ct_debit' }] : [],
    ),
    listCustomerAccountStates: jest.fn(async () =>
      frozen ? [{ id: 'cas_1', frozen: true, cause: 'manual' }] : [],
    ),
    claimWithdrawalAgainstDebit: jest.fn(
      async (input: { id: string; from: string[]; to: string }) => {
        const to = debitExists ? input.to : 'failed';
        if (input.id !== row.id) return { debited: debitExists, claimed: true };
        if (!input.from.includes(row.status)) {
          return { debited: debitExists, claimed: false };
        }
        row.status = to;
        return { debited: debitExists, claimed: true };
      },
    ),
    // The bare, UNLOCKED claim. Same reason as listCreditTransactions: it
    // exists here only so the guard below can prove the routes stopped
    // reaching for it directly.
    claimGlobePayWithdrawalStatus: jest.fn(
      async (input: { id: string; from: string[]; to: string }) => {
        if (input.id !== row.id) return true;
        if (!input.from.includes(row.status)) return false;
        row.status = input.to;
        return true;
      },
    ),
    updateGlobePayWithdrawals: jest.fn().mockResolvedValue(undefined),
    withdrawCreditsWithLedger: jest
      .fn()
      .mockResolvedValue({ id: 'ct_refund', replayed: false }),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  // TGPay's payout needs the recipient email, read from the customer module.
  const customers = {
    retrieveCustomer: jest.fn(async () => ({
      email: 'cus1@x.test',
      first_name: 'Ahmad',
      last_name: 'Ali',
      phone: '0123456789',
    })),
  };
  const scope = {
    resolve: (k: string) =>
      k === 'logger' ? logger : k === 'customer' ? customers : packs,
  };
  const req = {
    scope,
    params: { id: row.id },
    auth_context: { actor_id: 'usr_admin_1' },
    headers: {},
    ip: '10.0.0.7',
  } as never;
  return { packs, logger, scope, req, row };
}

const mkRes = () => {
  const out: { body?: Record<string, unknown> } = {};
  return {
    res: {
      setHeader: () => {},
      json: (b: Record<string, unknown>) => (out.body = b),
    } as never,
    out,
  };
};

/** Every log line this pair writes, flattened — the "never the number" scan. */
const allLogLines = (logger: {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
}) =>
  [
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
  ]
    .map((c) => String(c[0]))
    .join('\n');

beforeEach(() => {
  submitMock.mockReset();
  submitMock.mockResolvedValue({ transactionId: 'W2026081200000001' });
  notifyFeedMock.mockClear();
  receipt.mockClear();
  process.env.GLOBEPAY_ENABLED = 'true';
  process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'true';
  process.env.TGPAY_API_BASE = 'https://sandbox-api.example.test/api/v2';
  process.env.TGPAY_PUBLIC_KEY = 'pk-test';
  process.env.TGPAY_SECRET_KEY = 'sk-test';
  process.env.PAYMENT_CALLBACK_BASE = 'https://us';
});

describe('POST /admin/globepay/withdrawals/:id/approve', () => {
  it('submits the row’s OWN stored destination and stamps the gateway id', async () => {
    const h = harness();
    const { res, out } = mkRes();
    await APPROVE(h.req, res);

    expect(submitMock).toHaveBeenCalledTimes(1);
    const [payload] = submitMock.mock.calls[0];
    expect(payload).toMatchObject({
      merchantTransactionId: 'PW-HELD-1',
      merchantClientId: 'cus_1',
      // bigNumber columns arrive as strings; submitWithdrawal calls
      // .toFixed(2) on this, which would throw on the raw value.
      amount: 1500,
      destinationBankCode: 'MBBEMYKL',
      destinationAccountNumber: ACCOUNT_NUMBER,
      destinationAccountHolderName: 'AHMAD BIN ALI',
    });
    // The claim ran BEFORE the gateway saw anything, and it carried the
    // payout's own `wd:` debit anchor so the service could resolve the debit
    // under the lock.
    expect(h.packs.claimWithdrawalAgainstDebit).toHaveBeenCalledWith({
      id: 'gpw_1',
      customerId: 'cus_1',
      debitReference: withdrawalIdempotencyReference('cus_1', 'PW-HELD-1'),
      from: ['held'],
      to: 'pending',
    });
    expect(
      h.packs.claimWithdrawalAgainstDebit.mock.invocationCallOrder[0],
    ).toBeLessThan(submitMock.mock.invocationCallOrder[0]);
    // Their W… id lands on the row — scoped to 'pending', so a sweep that
    // closed the row while the submit was in flight cannot end up with a
    // refunded row wearing a payout's gateway id.
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      selector: { id: 'gpw_1', status: 'pending' },
      data: { gateway_transaction_id: 'W2026081200000001' },
    });
    expect(out.body).toMatchObject({
      id: 'gpw_1',
      status: 'pending',
      transaction_id: 'W2026081200000001',
      approved: true,
    });
  });

  // THE money test. A double-clicked Approve is the realistic trigger, and the
  // failure mode is a duplicate payout to a real bank account.
  it('a double approve submits exactly ONCE — the second click loses the claim', async () => {
    const h = harness();
    const first = mkRes();
    const second = mkRes();
    await APPROVE(h.req, first.res);
    await APPROVE(h.req, second.res);

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(h.packs.claimWithdrawalAgainstDebit).toHaveBeenCalledTimes(2);
    expect(second.out.body).toMatchObject({ approved: false });
    // The status flip must be the CLAIM's, never a find-then-write: an
    // updateGlobePayWithdrawals carrying a status is exactly the unlocked
    // path the brief forbids.
    for (const [arg] of h.packs.updateGlobePayWithdrawals.mock.calls) {
      expect(arg).not.toHaveProperty('status');
      expect(arg?.data?.status).toBeUndefined();
    }
  });

  it('approve on a row already pending is a no-op, not an error', async () => {
    const h = harness({ ...heldRow(), status: 'pending' });
    const { res, out } = mkRes();
    await APPROVE(h.req, res);
    expect(submitMock).not.toHaveBeenCalled();
    expect(out.body).toMatchObject({ approved: false, status: 'pending' });
  });

  it('a DEFINITE refusal refunds on the shared anchor and closes the row failed', async () => {
    const h = harness();
    submitMock.mockRejectedValue(
      new GatewayError('Insufficient payout float', ['PMT10013'], 400, true),
    );
    const { res } = mkRes();

    await expect(APPROVE(h.req, res)).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
    });

    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);
    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledWith({
      customerId: 'cus_1',
      amount: 1500,
      reason: 'cashout',
      reference: 'PW-HELD-1',
      idempotencyReference: withdrawalRefundReference('cus_1', 'PW-HELD-1'),
      ledger: {
        outcome: 'refunded',
        bankCode: 'MBBEMYKL',
        accountNumber: ACCOUNT_NUMBER,
        gatewayRef: 'PW-HELD-1',
      },
    });
    // The claim left the row 'pending', so the helper's terminal update must
    // be scoped to THAT status or the row never closes.
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      selector: { id: 'gpw_1', status: 'pending' },
      // Plan 095: the close carries the gateway's own codes, so a refused
      // approval stays explainable after the run logs rotate.
      data: {
        status: 'failed',
        gateway_status: null,
        failure_reason: expect.stringContaining('PMT10013'),
      },
    });
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(notifyFeedMock).toHaveBeenCalledTimes(1);

    // Their reason, on record — the only thing that can tell PMT10013 (empty
    // merchant float) apart from genuinely bad bank details later: a
    // definitively refused submit leaves NOTHING at the gateway to requery.
    // All seven fields are pinned, so none can be dropped from the line.
    const warned = h.logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('PMT10013');
    expect(warned).toContain('httpStatus=400');
    expect(warned).toContain('definite=true');
    expect(warned).toContain('bankCode=MBB');
    expect(warned).toContain('amount=1500');
    expect(warned).toContain('PW-HELD-1');
    expect(warned).toContain('Insufficient payout float');
  });

  it('an AMBIGUOUS submit error leaves the row pending for the sweep — never a refund', async () => {
    const h = harness();
    submitMock.mockRejectedValue(new Error('socket hang up'));
    const { res, out } = mkRes();

    await APPROVE(h.req, res);

    // Refunding here double-pays: the payout may still have executed.
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.row.status).toBe('pending');
    // Exactly the state the sweep expects: pending, no gateway id.
    expect(out.body).toMatchObject({
      status: 'pending',
      transaction_id: null,
      approved: true,
    });
    expect(
      h.logger.error.mock.calls.map((c) => String(c[0])).join('\n'),
    ).toMatch(/ambiguous/i);
  });

  // Beyond the brief's list, and deliberate: a crash between the row insert
  // and the debit strands a held row with NO debit. Submitting it pays a bank
  // account against a balance that was never reduced. The destructive close
  // has to stay available for exactly this row.
  it('refuses to submit a held row that was never debited, closing it instead', async () => {
    const h = harness(heldRow(), false);
    const { res } = mkRes();

    await expect(APPROVE(h.req, res)).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
    });

    expect(submitMock).not.toHaveBeenCalled();
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    // Closed through the locked claim, so it can race neither a concurrent
    // deny nor the debit itself.
    expect(h.packs.claimWithdrawalAgainstDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gpw_1',
        customerId: 'cus_1',
        debitReference: withdrawalIdempotencyReference('cus_1', 'PW-HELD-1'),
        from: ['held'],
      }),
    );
    expect(h.row.status).toBe('failed');
  });

  it('404s an unknown id without claiming anything', async () => {
    const h = harness();
    const req = { ...(h.req as object), params: { id: 'gpw_nope' } } as never;
    const { res } = mkRes();
    await expect(APPROVE(req, res)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
    });
    expect(h.packs.claimWithdrawalAgainstDebit).not.toHaveBeenCalled();
  });

  it('logs the actor and the row, and NEVER the account number', async () => {
    const h = harness();
    const { res } = mkRes();
    await APPROVE(h.req, res);
    const lines = allLogLines(h.logger);
    expect(lines).toContain('usr_admin_1');
    expect(lines).toContain('gpw_1');
    // Boolean, not .not.toContain(): a failing toContain prints the whole
    // logged string — the account number — into a public CI log.
    expect(lines.includes(ACCOUNT_NUMBER)).toBe(false);
  });

  it('every precondition is checked BEFORE the claim — a refused approve leaves the row held', async () => {
    process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'false';
    const h = harness();
    const { res } = mkRes();
    await expect(APPROVE(h.req, res)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
    });
    expect(h.packs.claimWithdrawalAgainstDebit).not.toHaveBeenCalled();
    expect(h.row.status).toBe('held');
  });

  // The one piece of the request-time gate that must be re-read: a freeze
  // landing while the row sat held is exactly how "this payout is suspicious"
  // gets recorded, and nothing guarantees the approver can see the flag.
  it('refuses a frozen customer before the claim, whatever the freeze cause', async () => {
    const h = harness(heldRow(), true, true);
    const { res } = mkRes();
    await expect(APPROVE(h.req, res)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
    });
    expect(h.packs.claimWithdrawalAgainstDebit).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(h.row.status).toBe('held');
    // Cause-agnostic, like the request-time gate (walletSummary.isFrozen) —
    // an auto clawback-debt freeze must block a payout too, which is why this
    // is not packs.assertNotFrozen (manual-only).
    expect(h.packs.listCustomerAccountStates).toHaveBeenCalledWith(
      { customer_id: 'cus_1', frozen: true },
      { take: 1 },
    );
  });

  it('a missing NotifyUrl refuses before the claim — a payout that could never refund', async () => {
    delete process.env.PAYMENT_CALLBACK_BASE;
    const h = harness();
    const { res } = mkRes();
    await expect(APPROVE(h.req, res)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
    });
    expect(h.packs.claimWithdrawalAgainstDebit).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe('POST /admin/globepay/withdrawals/:id/deny', () => {
  it('CLAIMS the row failed before refunding — inverting this loses the approve race', async () => {
    const h = harness();
    const { res, out } = mkRes();
    await DENY(h.req, res);

    expect(h.packs.claimWithdrawalAgainstDebit).toHaveBeenCalledWith({
      id: 'gpw_1',
      customerId: 'cus_1',
      debitReference: withdrawalIdempotencyReference('cus_1', 'PW-HELD-1'),
      from: ['held', 'failed'],
      to: 'failed',
    });
    expect(
      h.packs.claimWithdrawalAgainstDebit.mock.invocationCallOrder[0],
    ).toBeLessThan(
      h.packs.withdrawCreditsWithLedger.mock.invocationCallOrder[0],
    );
    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        amount: 1500,
        idempotencyReference: withdrawalRefundReference('cus_1', 'PW-HELD-1'),
      }),
    );
    // The claim already put the row in 'failed', so the helper's terminal
    // update must be scoped to THAT — scoped to 'pending' it is a silent
    // no-op that would leave the four-step ordering half-applied.
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      selector: { id: 'gpw_1', status: 'failed' },
      // Plan 095: names the admin, so a denied row is never later mistaken
      // for one the gateway refused.
      data: {
        status: 'failed',
        gateway_status: null,
        failure_reason: expect.stringContaining('denied by admin'),
      },
    });
    expect(out.body).toMatchObject({
      id: 'gpw_1',
      status: 'failed',
      refunded: true,
    });
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(notifyFeedMock).toHaveBeenCalledTimes(1);
  });

  it('a replayed deny credits exactly once — same anchor, one notification', async () => {
    const h = harness();
    h.packs.withdrawCreditsWithLedger
      .mockResolvedValueOnce({ id: 'ct_refund', replayed: false })
      .mockResolvedValueOnce({ id: 'ct_refund', replayed: true });

    await DENY(h.req, mkRes().res);
    await DENY(h.req, mkRes().res);

    // Both calls land on the ONE anchor, which is what makes the second a
    // replay in the ledger instead of a second credit.
    const anchors = h.packs.withdrawCreditsWithLedger.mock.calls.map(
      (c) => c[0].idempotencyReference,
    );
    expect(anchors).toEqual([
      withdrawalRefundReference('cus_1', 'PW-HELD-1'),
      withdrawalRefundReference('cus_1', 'PW-HELD-1'),
    ]);
    // The customer is told once — the !replayed guard in the helper.
    expect(notifyFeedMock).toHaveBeenCalledTimes(1);
  });

  // The recovery path the claim-first ordering exists to make safe: a crash
  // between the claim and the refund leaves a `failed` row whose debit never
  // came back, and the sweep (pending-only) will never revisit it. An
  // operator clicking Deny again must settle it.
  it('a re-run on its OWN failed row still refunds it', async () => {
    const h = harness({ ...heldRow(), status: 'failed' });
    const { res, out } = mkRes();
    await DENY(h.req, res);
    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);
    expect(out.body).toMatchObject({ status: 'failed', refunded: true });
    // The crash-window re-run finds NO reason on the row (the claim writes
    // none), so this is the run that stamps the admin's.
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failure_reason: expect.stringContaining('denied by admin'),
        }),
      }),
    );
  });

  // Deny accepts 'failed' so the crash window above is recoverable — which
  // also lets an operator click it on a row the bank already refused. That
  // replay is harmless to the money (one anchor) but used to overwrite the
  // bank's diagnostic with "denied by admin", and the deploy's logs have
  // rotated by then (review 2026-09).
  it("a mistaken Deny on a row the gateway closed keeps the gateway's failure_reason", async () => {
    const h = harness({
      ...heldRow(),
      status: 'failed',
      gateway_status: 5,
      failure_reason: 'sweep: requery statusId 5',
    });
    await DENY(h.req, mkRes().res);
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      selector: { id: 'gpw_1', status: 'failed' },
      data: { status: 'failed', gateway_status: 5 },
    });
  });

  it('refuses a settled row — nothing moves', async () => {
    const h = harness({ ...heldRow(), status: 'settled' });
    const { res } = mkRes();
    await expect(DENY(h.req, res)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
    });
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
  });

  it('refuses a pending row — that one belongs to the sweep', async () => {
    const h = harness({ ...heldRow(), status: 'pending' });
    const { res } = mkRes();
    await expect(DENY(h.req, res)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_ALLOWED,
    });
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });

  // Bound finding: a held row is NOT always debited. Refunding one that never
  // was mints money.
  it('closes a never-debited row WITHOUT refunding it', async () => {
    const h = harness(heldRow(), false);
    const { res, out } = mkRes();
    await DENY(h.req, res);

    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
    expect(h.row.status).toBe('failed');
    expect(out.body).toMatchObject({ status: 'failed', refunded: false });
    expect(
      h.logger.warn.mock.calls.map((c) => String(c[0])).join('\n'),
    ).toMatch(/no debit/i);
  });

  // Asymmetric with approve on purpose: handing money back must not depend on
  // the payout channel being open.
  it('still works with the payout channel switched off', async () => {
    process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'false';
    const h = harness();
    const { res, out } = mkRes();
    await DENY(h.req, res);
    expect(out.body).toMatchObject({ refunded: true });
  });

  it('logs the actor and the row, and NEVER the account number', async () => {
    const h = harness();
    await DENY(h.req, mkRes().res);
    const lines = allLogLines(h.logger);
    expect(lines).toContain('usr_admin_1');
    expect(lines).toContain('gpw_1');
    expect(lines.includes(ACCOUNT_NUMBER)).toBe(false);
  });

  it('404s an unknown id without claiming anything', async () => {
    const h = harness();
    const req = { ...(h.req as object), params: { id: 'gpw_nope' } } as never;
    await expect(DENY(req, mkRes().res)).rejects.toMatchObject({
      type: MedusaError.Types.NOT_FOUND,
    });
    expect(h.packs.claimWithdrawalAgainstDebit).not.toHaveBeenCalled();
  });
});

/**
 * THE REGRESSION GUARD for the finding that produced claimWithdrawalAgainstDebit.
 *
 * Both routes used to read the debit with an unlocked
 * packs.listCreditTransactions and then flip the row with a bare
 * packs.claimGlobePayWithdrawalStatus. Between those two calls a debit
 * queued on the customer's `credit:` lock could commit, so an admin could
 * close a row that was about to be debited and strand the money — the sweep
 * selects 'pending' only and never revisits a 'failed' row. The age gate that
 * used to paper over this is gone (no elapsed time can prove a debit
 * finished: a transaction blocked on pg_advisory_xact_lock is `active`, so
 * idle_in_transaction_session_timeout never fires on it).
 *
 * Reintroducing either unlocked call reopens the window while every other
 * test here stays green, so it is asserted directly rather than left implied.
 */
describe('the debit decision never happens outside the lock', () => {
  it.each([
    ['approve', APPROVE],
    ['deny', DENY],
  ])(
    '%s reads and claims only through claimWithdrawalAgainstDebit',
    async (_name, handler) => {
      const h = harness();
      await handler(h.req, mkRes().res);
      expect(h.packs.claimWithdrawalAgainstDebit).toHaveBeenCalledTimes(1);
      expect(h.packs.listCreditTransactions).not.toHaveBeenCalled();
      expect(h.packs.claimGlobePayWithdrawalStatus).not.toHaveBeenCalled();
    },
  );
});

// Auth is NOT exercised here (no router, no middleware chain) — these routes
// are protected by the framework's blanket '/admin' guard like every sibling.
//
// Nor is the rate-limit registration: api/__tests__/admin-rate-limit-coverage
// .unit.spec.ts already fails when ANY admin route.ts exports a mutation
// method with no adminActionRateLimit matcher covering its URL — it is what
// caught these two routes before their matchers existed. A source-text regex
// here would be the weaker copy of that: broken by a prettier reflow, and
// green for a matcher typo'd to a path that matches nothing.
