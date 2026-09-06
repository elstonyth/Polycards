jest.mock('../../modules/packs/notify-feed', () => ({
  notifyFeed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../modules/packs/topup-receipt', () => ({
  sendTopupReceipt: jest.fn().mockResolvedValue(true),
}));

import { setActiveGateway } from '../../modules/packs/gateway';
import { fakeGateway } from '../../modules/packs/fake-gateway';
import globepayReconcileJob, {
  __resetFullSweepMarkerForTests,
} from '../globepay-reconcile';
import type { FakeFacet, GatewayDeposits } from '../../modules/packs/facets';

/**
 * WHY this file exists: nothing in the repo imported the deposit sweep, so its
 * settle branch had no test at any tier — on the path that, in production,
 * does ALL the crediting (the callback has been unreliable since launch).
 *
 * Its one purpose is the branch the outcome module added: applyDepositOutcome
 * now fences the requeried amount against the row, which the sweep never did,
 * and a refusal there must QUARANTINE — no credit, no write-off, the row left
 * where it is for a human. Get that wrong in the other direction and a
 * disagreeing requery silently credits whatever the gateway said.
 *
 * The gateway is NOT mocked: the row names the fake gateway, so the job's own
 * per-row config lookup hands getDepositDetail a fake config and the seam
 * dispatches to fake-gateway.ts.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  fakeGateway.reset();
  setActiveGateway(null);
  __resetFullSweepMarkerForTests();
  process.env.GLOBEPAY_ENABLED = 'true';
  // The fake gateway needs no credentials.
  process.env.PAYMENT_GATEWAY = 'fake';
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

const pendingRow = {
  id: 'gpd_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-1',
  gateway_transaction_id: 'tx-1',
  amount_requested: 50,
  payment_method_code: 'OB',
  status: 'pending' as const,
  gateway: 'fake',
  created_at: new Date(),
};

function harness(deposit: Record<string, unknown> = pendingRow) {
  const packs = {
    // Status-aware, like the real query: the job makes a second, 'expired'
    // scan on a full sweep, and a mock that answered both would double-count
    // the same row.
    listGlobePayDeposits: jest.fn((selector: Record<string, unknown> = {}) =>
      Promise.resolve(
        selector.status === undefined || selector.status === deposit.status
          ? [deposit]
          : [],
      ),
    ),
    claimGlobePayDepositStatus: jest.fn().mockResolvedValue(true),
    topUpCreditsWithLedger: jest.fn().mockResolvedValue({
      id: 'ct_1',
      balance: 50,
      amount: 50,
      replayed: false,
      reference: null,
    }),
  } satisfies FakeFacet<GatewayDeposits>;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const container = {
    resolve: (k: string) => (k === 'logger' ? logger : packs),
  } as never;
  return { packs, logger, container };
}

describe('deposit sweep — settling from a requery', () => {
  it('credits the requeried amount and claims the row when it matches', async () => {
    const h = harness();
    fakeGateway.script({
      getDepositDetail: { state: 'success', amount: 50, netAmount: 48.5 },
    });

    await globepayReconcileJob(h.container);

    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_1', amount: 50 }),
    );
    expect(h.packs.claimGlobePayDepositStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gpd_1',
        from: ['pending'],
        to: 'settled',
        money: expect.objectContaining({
          amount_settled: 50,
          net_amount: 48.5,
        }),
      }),
    );
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('1 settled'),
    );
  });

  // THE test this file was written for. The callback route has always refused
  // an amount that is not the row's; the sweep used to credit it.
  it('quarantines a requery that disagrees with the row — no credit, no write-off', async () => {
    const h = harness();
    fakeGateway.script({
      getDepositDetail: { state: 'success', amount: 60 },
    });

    await globepayReconcileJob(h.container);

    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.claimGlobePayDepositStatus).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/amount-mismatch/),
    );
    // Counted, not merely logged: an operator reads the summary line.
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('1 quarantined'),
    );
  });

  it('writes a rejected deposit off through the same outcome module', async () => {
    const h = harness();
    fakeGateway.script({ getDepositDetail: { state: 'failed' } });

    await globepayReconcileJob(h.container);

    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.claimGlobePayDepositStatus).toHaveBeenCalledWith(
      expect.objectContaining({ from: ['pending'], to: 'failed' }),
    );
  });
});
