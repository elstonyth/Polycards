import { GlobePayError } from '../../modules/packs/globepay-client';

// The gateway's HTTP seam is the only thing mocked; every decision under test
// is the job's own.
jest.mock('../../modules/packs/globepay-client', () => {
  const actual = jest.requireActual('../../modules/packs/globepay-client');
  return { ...actual, getWithdrawalDetail: jest.fn() };
});
jest.mock('../../modules/packs/notify-feed', () => ({
  notifyFeed: jest.fn().mockResolvedValue(undefined),
}));
// Unmocked, sendWithdrawalReceipt's REAL body runs and silently swallows its
// own failure (the bare mock container resolves Modules.CUSTOMER to `packs`,
// which has no retrieveCustomer, so it throws internally, logs, and returns
// false) — every existing test already tolerated that with zero assertions
// on it. Mocking it here doesn't change what any existing test observes
// (none inspect it or its would-be internal log line); it only makes step 2
// of the extracted refund ordering assertable, same as notify-feed already is.
jest.mock('../../modules/packs/withdrawal-receipt', () => ({
  sendWithdrawalReceipt: jest.fn().mockResolvedValue(true),
}));

import { getWithdrawalDetail } from '../../modules/packs/globepay-client';
import { notifyFeed } from '../../modules/packs/notify-feed';
import { sendWithdrawalReceipt } from '../../modules/packs/withdrawal-receipt';
import globepayWithdrawalReconcileJob from '../globepay-withdrawal-reconcile';
import { GLOBEPAY_STALE_AFTER_MS } from '../../modules/packs/globepay-reconcile';
import { withdrawalRefundReference } from '../../modules/packs/globepay-withdrawal';

const requery = getWithdrawalDetail as jest.Mock;
// Both are module-level mocks shared across every test in this file (Jest
// does not reset them automatically — no resetMocks/clearMocks in
// jest.config.js), so their call history is cleared per-test in beforeEach
// below. requery is fully mockReset (every test sets its own resolved/
// rejected value); these two keep their default resolved value and are only
// mockClear'd, since nothing needs to override it per test.
const notifyFeedMock = notifyFeed as jest.Mock;
const receipt = sendWithdrawalReceipt as jest.Mock;

// WHY this file exists: nothing in the repo imported this job. The unit specs
// cover the SUBMIT path and the integration specs cover the CALLBACK loop —
// neither executes the sweep. So the ambiguous-refusal branch, the one standing
// between a rotated merchant key and a refund of every in-flight payout, could
// be deleted with the whole suite still green. On the money-OUT path.
beforeEach(() => {
  requery.mockReset();
  notifyFeedMock.mockClear();
  receipt.mockClear();
  process.env.GLOBEPAY_ENABLED = 'true';
  process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'true';
  process.env.GLOBEPAY_MERCHANT_CODE = 'Testpolycard';
  process.env.GLOBEPAY_API_BASE = 'https://mapi.example.test';
  process.env.GLOBEPAY_AES_KEY = 'test-aes-key';
  process.env.GLOBEPAY_MERCHANT_PRIVATE_KEY = 'test-private-key';
  process.env.GLOBEPAY_PUBLIC_KEY = 'test-public-key';
});

/** An ambiguous-submit row: the debit landed, SubmitWithdrawal never returned,
 * so there is NO gateway id — the population the unknown-refund path exists
 * for, and therefore the one an ambiguous 400 could wrongly refund. */
const REQUESTED_AT = new Date(Date.now() - GLOBEPAY_STALE_AFTER_MS * 24);
const pendingRow = {
  id: 'gpw_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PW-1',
  gateway_transaction_id: null,
  amount: 100,
  bank_code: 'MBB',
  account_number: '1234567890',
  status: 'pending',
  created_at: REQUESTED_AT,
  // Equal to created_at, because that is what a store-path row looks like:
  // nothing writes to it between the insert and an ambiguous submit, so its
  // updated_at IS its submit time — the clock the sweep reads (plan 094).
  // Both columns are NOT NULL in the schema, so a fixture carrying only one
  // of them is not a row this code can ever meet.
  updated_at: REQUESTED_AT,
};

function harness(withdrawal: Record<string, unknown> = pendingRow) {
  const packs = {
    // Selector-aware, unlike a bare mockResolvedValue: the job now makes TWO
    // differently-filtered listGlobePayWithdrawals calls (pending, then
    // held), so a mock that returns `withdrawal` for any selector would hand
    // it back for BOTH regardless of its actual `.status` — misreporting a
    // pending fixture as the oldest held row (or vice versa) in nearly every
    // test in this file, since most fixtures share pendingRow's very old
    // created_at. Filtering by status is what a real query does.
    listGlobePayWithdrawals: jest.fn((selector: Record<string, unknown> = {}) =>
      Promise.resolve(
        selector.status === undefined || selector.status === withdrawal.status
          ? [withdrawal]
          : [],
      ),
    ),
    updateGlobePayWithdrawals: jest.fn().mockResolvedValue(undefined),
    // A debit row EXISTS, so the "never refund what was never debited" guard
    // cannot be what makes these tests pass — only the ambiguity check can.
    listCreditTransactions: jest.fn().mockResolvedValue([{ id: 'ct_debit' }]),
    withdrawCreditsWithLedger: jest
      .fn()
      .mockResolvedValue({ id: 'ct_1', replayed: false }),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const container = {
    resolve: (k: string) => (k === 'logger' ? logger : packs),
  } as never;
  return { packs, logger, container };
}

// The shape staging actually returns for a requery it does not recognise:
// HTTP 400, plain-text "Not found", no PMT10016
// (docs/payments/globepay365-setup.md:124). Indistinguishable from a rotated
// key or a de-whitelisted IP, so it must not move money. Hoisted to module
// scope — a pure move, no logic change — so the slow-payout-clock tests
// further down can drive the same 'wait' branch without a second copy.
const ambiguous400 = () =>
  new GlobePayError(
    'GlobePay365 /api/Withdrawal/GetWithdrawalDetail: non-JSON response (HTTP 400): Not found',
    [],
    400,
  );

describe('withdrawal sweep — an unattributable 400 never refunds', () => {
  it('does not refund, does not close the row, and says so loudly', async () => {
    const h = harness();
    requery.mockRejectedValue(ambiguous400());

    await globepayWithdrawalReconcileJob(h.container);

    // THE assertion. A refund here double-pays: the bank may still execute the
    // payout while the customer's balance is credited back.
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('check merchant credentials'),
    );
  });

  it('a parsed 400 carrying some OTHER error code is equally unactionable', async () => {
    const h = harness();
    requery.mockRejectedValue(
      new GlobePayError('Invalid merchant', ['PMT10006'], 400, true),
    );

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
  });

  it('still refunds on an EXPLICIT not-found — this is a narrowing, not a removal', async () => {
    const h = harness();
    requery.mockRejectedValue(
      new GlobePayError('Not found', ['PMT10016'], 400, true),
    );

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('still refunds when the gateway itself reports the payout failed', async () => {
    const h = harness();
    requery.mockResolvedValue({ state: 'failed', statusId: 5 });

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);
  });

  // The settlement mirror on the SWEEP path (audit 2026-08-17 B1/B2/C2).
  // The sweep was production's only settle path for a month (callbacks dead
  // until 2026-08-13), so "requery-settled rows carry net/refs" is exactly
  // the population the settlement report leans on after any callback outage.
  it('a requery settle persists settled amount, net and bank references — never the ledger', async () => {
    const h = harness();
    requery.mockResolvedValue({
      state: 'success',
      statusId: 4,
      amount: 100,
      netAmount: 98.5,
      bankReferenceNo: 'BR-42',
      uniqueReferenceNo: 'UR-43',
    });

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { id: 'gpw_1', status: 'pending' },
        data: expect.objectContaining({
          status: 'settled',
          amount_settled: 100,
          net_amount: 98.5,
          bank_reference_no: 'BR-42',
          unique_reference_no: 'UR-43',
        }),
      }),
    );
    // Settle never touches money — the debit already happened at submit.
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });

  // NULL means UNKNOWN, never "no fee" — same rule as both callback hooks.
  it('a requery settle with no net stores null, never zero', async () => {
    const h = harness();
    requery.mockResolvedValue({ state: 'success', statusId: 4, amount: 100 });

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'settled',
          net_amount: null,
          bank_reference_no: null,
          unique_reference_no: null,
        }),
      }),
    );
  });

  it('a non-400 refusal is rethrown into the per-row catch, not read as an answer', async () => {
    const h = harness();
    requery.mockRejectedValue(new GlobePayError('their outage', [], 500));

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    // The row survives the sweep and is retried next run.
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('their outage'),
    );
  });
});

describe('withdrawal sweep — a held row is structurally invisible to it', () => {
  // 'held' rows are debited (plan 094) but must never be swept — see the
  // model's 'held' status comment. The ONLY thing that keeps one out of this
  // loop is the sweep's own query, `listGlobePayWithdrawals({status:
  // 'pending'}, ...)`. The mock below deliberately fails OPEN: it returns
  // the held row for any selector except the exact one the job sends today,
  // so a regression that drops or widens that filter makes the row
  // reappear here and the assertions below catch it. A mock that instead
  // hard-matched `withdrawal.status === 'held'` would still return `[]` for
  // a job that queried with no filter at all — green for a regression that
  // ships every held row into the loop.
  const heldRow = {
    ...pendingRow,
    id: 'gpw_held_1',
    merchant_transaction_id: 'PW-HELD-1',
    status: 'held',
  };

  it('does not sweep held rows — an approval queue would self-cancel', async () => {
    const h = harness(heldRow);
    h.packs.listGlobePayWithdrawals.mockImplementation(
      (selector: Record<string, unknown> = {}) =>
        Promise.resolve(selector.status === 'pending' ? [] : [heldRow]),
    );
    // Realistic gateway answer IF the filter above ever failed and this row
    // reached the loop: a held row was never submitted, so a real requery on
    // its merchant_transaction_id would come back not-found — the same
    // stale-and-unknown shape unknownWithdrawalAction resolves to a refund.
    // Configuring this (rather than leaving `requery` a bare unconfigured
    // mock) makes the regression this test guards against actually reach
    // withdrawCreditsWithLedger instead of crashing on an unrelated
    // `undefined.statusId` first — the failure must be caught by the RIGHT
    // mechanism, not an accidental one.
    requery.mockRejectedValue(
      new GlobePayError('Not found', ['PMT10016'], 400, true),
    );

    await globepayWithdrawalReconcileJob(h.container);

    // The mechanism: this is what has to keep matching for held rows to stay
    // out — not an assumption about what the mock happens to return.
    expect(h.packs.listGlobePayWithdrawals).toHaveBeenCalledWith(
      { status: 'pending' },
      expect.anything(),
    );
    // The outcome: nothing about the held row moved. It never even reached
    // the debit-existence guard, let alone a requery or a refund.
    expect(requery).not.toHaveBeenCalled();
    expect(h.packs.listCreditTransactions).not.toHaveBeenCalled();
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
    expect(notifyFeedMock).not.toHaveBeenCalled();
  });
});

describe('withdrawal sweep — the state an admin approval could leave ambiguous', () => {
  // What plan 094 Task 5's approve route (held -> pending, then
  // SubmitWithdrawal) would leave behind if ITS OWN submit call times out:
  // a 'pending' row with no gateway id, already debited (a 'held' row
  // always is — see startGlobePayWithdrawal), old enough that the sweep's
  // "never heard of it" answer resolves rather than waits. The test above
  // proves the SAFE state (held rows never move); this proves the REACHABLE
  // one that leaves uncovered — that once such a row lands here, the
  // extracted refund helper still closes it exactly once, on the same
  // anchor a racing callback or a retried sweep would land on too.
  const approvedThenAmbiguousRow = {
    ...pendingRow,
    id: 'gpw_approved_1',
    customer_id: 'cus_2',
    merchant_transaction_id: 'PW-APPROVED-1',
    gateway_transaction_id: null,
    amount: 250,
    bank_code: 'CIMB',
    account_number: '9876543210',
  };

  // THE regression guard for plan 094's staleness clock. A held row is as old
  // as the human took to look at it; the submit happened at APPROVAL. Read the
  // grace window off created_at and this row is born stale — this very tick
  // requeries a payout that has not propagated yet, gets a not-found, and
  // refunds a transfer the bank goes on to execute. Money out AND credited
  // back, unrecoverable.
  //
  // Deliberately the same not-found answer as the test below, and the row
  // sorts to the front of the batch (pending, oldest created_at first), so
  // nothing but the clock separates the two outcomes.
  const approvedMinutesAgoRow = {
    ...pendingRow,
    id: 'gpw_approved_fresh',
    customer_id: 'cus_3',
    merchant_transaction_id: 'PW-APPROVED-FRESH',
    // The customer asked six hours ago...
    created_at: new Date(Date.now() - 6 * 60 * 60 * 1000),
    // ...an admin approved it one minute ago, and the claim stamped this.
    updated_at: new Date(Date.now() - 60 * 1000),
  };

  it('does NOT refund a row approved minutes ago, however old the request is', async () => {
    const h = harness(approvedMinutesAgoRow);
    requery.mockRejectedValue(
      new GlobePayError('Not found', ['PMT10016'], 400, true),
    );

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
    expect(notifyFeedMock).not.toHaveBeenCalled();
  });

  it('refunds exactly once, on the shared anchor, and closes failed', async () => {
    const h = harness(approvedThenAmbiguousRow);
    requery.mockRejectedValue(
      new GlobePayError('Not found', ['PMT10016'], 400, true),
    );

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);
    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledWith({
      customerId: approvedThenAmbiguousRow.customer_id,
      amount: approvedThenAmbiguousRow.amount,
      reason: 'cashout',
      // No gateway id on the row: both the ledger reference and the
      // gateway ref fall back to our own merchant reference.
      reference: approvedThenAmbiguousRow.merchant_transaction_id,
      idempotencyReference: withdrawalRefundReference(
        approvedThenAmbiguousRow.customer_id,
        approvedThenAmbiguousRow.merchant_transaction_id,
      ),
      ledger: {
        outcome: 'refunded',
        bankCode: approvedThenAmbiguousRow.bank_code,
        accountNumber: approvedThenAmbiguousRow.account_number,
        gatewayRef: approvedThenAmbiguousRow.merchant_transaction_id,
      },
    });
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledTimes(1);
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith({
      selector: { id: approvedThenAmbiguousRow.id, status: 'pending' },
      // classifyRequeryError's not-found branch never sets gatewayStatus —
      // the row was never heard of, so there is no gateway status to record.
      // Plan 095: the sweep records WHICH verdict closed the row — a stale
      // payout with no gateway record reads differently from a requeried fail.
      data: {
        status: 'failed',
        gateway_status: null,
        failure_reason: 'sweep: stale with no gateway record',
      },
    });

    // Step 2 and step 4 of the extracted ordering — untouched by the
    // argument assertions above, which only reach steps 1 and 3.
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(receipt).toHaveBeenCalledWith(h.container, {
      customerId: approvedThenAmbiguousRow.customer_id,
      amount: approvedThenAmbiguousRow.amount,
      // No gateway id: `||` falls through to the merchant reference (see
      // the `||` vs `??` comment on this line in globepay-withdrawal.ts).
      reference: approvedThenAmbiguousRow.merchant_transaction_id,
      merchantTransactionId: approvedThenAmbiguousRow.merchant_transaction_id,
      outcome: 'refunded',
    });
    expect(notifyFeedMock).toHaveBeenCalledTimes(1);

    // Ordering: the receipt send must happen BEFORE the terminal row
    // update (see the load-bearing comment on this in
    // globepay-withdrawal.ts) — a crash after the update leaves nothing
    // that will ever re-run this branch for a held row's future deny
    // caller, so the email has to go out first.
    expect(receipt.mock.invocationCallOrder[0]).toBeLessThan(
      h.packs.updateGlobePayWithdrawals.mock.invocationCallOrder[0],
    );
  });
});

describe('withdrawal sweep — the 24h slow-payout alert reads the submit clock', () => {
  // Both rows are still 'processing' at the gateway (the ambiguous-400 wait
  // branch, same mechanism as the first describe block above) — only their
  // clocks differ. This is the regression net for plan 094's final review:
  // the slow-payout log used to read created_at, so an admin-approved row
  // (held for days, then approved and submitted a minute ago) fired "still
  // unresolved" on the very next sweep tick — an alert that cries wolf on
  // every approved payout trains operators to ignore it.
  const justApprovedRow = {
    ...pendingRow,
    id: 'gpw_slow_fresh',
    merchant_transaction_id: 'PW-SLOW-FRESH',
    // The customer asked three days ago...
    created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    // ...an admin approved it a minute ago, and the claim stamped this.
    updated_at: new Date(Date.now() - 60 * 1000),
  };
  const genuinelyStuckRow = {
    ...pendingRow,
    id: 'gpw_slow_stuck',
    merchant_transaction_id: 'PW-SLOW-STUCK',
    // A store-path row: submitted (and therefore created) 25 hours ago,
    // still unresolved at the gateway. Proves the fix is a clock swap, not a
    // silent delete of the alert.
    created_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
    updated_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
  };

  it('does not cry wolf on a payout approved minutes ago, however old the request', async () => {
    const h = harness(justApprovedRow);
    requery.mockRejectedValue(ambiguous400());

    await globepayWithdrawalReconcileJob(h.container);

    const messages = h.logger.error.mock.calls.map(([m]: [string]) => m);
    expect(messages.some((m) => m.includes('still unresolved'))).toBe(false);
  });

  it('still warns once the payout itself has sat at the gateway over a day', async () => {
    const h = harness(genuinelyStuckRow);
    requery.mockRejectedValue(ambiguous400());

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('chase the provider'),
    );
  });
});

describe('withdrawal sweep — a held row gets its own staleness watch', () => {
  // Nothing else ages a held row: it is structurally invisible to the
  // sweep's PROCESSING loop (see the describe block above), and the admin
  // list's `stale` flag is `status === 'pending'` only (route.ts). This is
  // the one place a held row is read at all, and it is read-only — never
  // requeried, refunded, or written to.
  const freshHeldRow = {
    ...pendingRow,
    id: 'gpw_held_fresh',
    merchant_transaction_id: 'PW-HELD-FRESH',
    status: 'held',
    created_at: new Date(Date.now() - 60 * 1000),
  };
  const staleHeldRow = {
    ...pendingRow,
    id: 'gpw_held_stale',
    merchant_transaction_id: 'PW-HELD-STALE',
    customer_id: 'cus_stale',
    amount: 5000,
    status: 'held',
    created_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
  };

  it('logs nothing for a held row still inside the grace window', async () => {
    const h = harness(freshHeldRow);

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.logger.error).not.toHaveBeenCalled();
    // Read-only, even though it was read: nothing about the row moved.
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(requery).not.toHaveBeenCalled();
  });

  // Also proves the check does not live behind the `outstanding.length === 0`
  // early return: this fixture's status is 'held', so the pending query
  // returns nothing and the sweep would otherwise stop right after — a queue
  // that is 100% held must still get the watch.
  it('warns once a held row has waited past the threshold — nothing else will', async () => {
    const h = harness(staleHeldRow);

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('PW-HELD-STALE'),
    );
    // Still read-only past the threshold — a log line, not an action.
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(requery).not.toHaveBeenCalled();
  });

  // Review-fix companion: the watch sits in its own try/catch specifically so
  // it can never take the money-resolving loop below down with it. A DB blip
  // on this read-only query must not cost a stranded pending debit its
  // resolution for the tick.
  it('a throw from the watch is logged, and the pending sweep below still runs', async () => {
    const h = harness(pendingRow);
    h.packs.listGlobePayWithdrawals.mockImplementation(
      (selector: Record<string, unknown> = {}) => {
        if (selector.status === 'held') {
          return Promise.reject(new Error('db blip'));
        }
        return Promise.resolve(
          selector.status === undefined || selector.status === pendingRow.status
            ? [pendingRow]
            : [],
        );
      },
    );
    requery.mockResolvedValue({ state: 'failed', statusId: 5 });

    await globepayWithdrawalReconcileJob(h.container);

    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('held-row staleness watch failed'),
    );
    // The pending row was still resolved — the throw above cost this tick
    // nothing but the one log line.
    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);
  });
});
