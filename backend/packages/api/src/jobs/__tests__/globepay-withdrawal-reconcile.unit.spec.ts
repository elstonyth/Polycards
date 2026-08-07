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

import { getWithdrawalDetail } from '../../modules/packs/globepay-client';
import globepayWithdrawalReconcileJob from '../globepay-withdrawal-reconcile';
import { GLOBEPAY_STALE_AFTER_MS } from '../../modules/packs/globepay-reconcile';

const requery = getWithdrawalDetail as jest.Mock;

// WHY this file exists: nothing in the repo imported this job. The unit specs
// cover the SUBMIT path and the integration specs cover the CALLBACK loop —
// neither executes the sweep. So the ambiguous-refusal branch, the one standing
// between a rotated merchant key and a refund of every in-flight payout, could
// be deleted with the whole suite still green. On the money-OUT path.
beforeEach(() => {
  requery.mockReset();
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
const pendingRow = {
  id: 'gpw_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PW-1',
  gateway_transaction_id: null,
  amount: 100,
  bank_code: 'MBB',
  account_number: '1234567890',
  status: 'pending',
  created_at: new Date(Date.now() - GLOBEPAY_STALE_AFTER_MS * 24),
};

function harness(withdrawal: Record<string, unknown> = pendingRow) {
  const packs = {
    listGlobePayWithdrawals: jest.fn().mockResolvedValue([withdrawal]),
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

describe('withdrawal sweep — an unattributable 400 never refunds', () => {
  // The shape staging actually returns for a requery it does not recognise:
  // HTTP 400, plain-text "Not found", no PMT10016
  // (docs/payments/globepay365-setup.md:124). Indistinguishable from a rotated
  // key or a de-whitelisted IP, so it must not move money.
  const ambiguous400 = () =>
    new GlobePayError(
      'GlobePay365 /api/Withdrawal/GetWithdrawalDetail: non-JSON response (HTTP 400): Not found',
      [],
      400,
    );

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
