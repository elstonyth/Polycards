jest.mock('../../modules/packs/notify-feed', () => ({
  notifyFeed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../modules/packs/topup-receipt', () => ({
  sendTopupReceipt: jest.fn().mockResolvedValue(true),
}));

import { setActiveGateway } from '../../modules/packs/gateway';
import { fakeGateway } from '../../modules/packs/fake-gateway';
import depositReconcileJob, {
  __resetFullSweepMarkerForTests,
} from '../deposit-reconcile';
import type { FakeFacet, GatewayDeposits } from '../../modules/packs/facets';

/**
 * WHY this file exists: nothing in the repo imported the deposit sweep, so its
 * settle branch had no test at any tier — on the path that, in production,
 * does ALL the crediting (the callback has been unreliable since launch).
 *
 * Its one purpose is the sweep's AMOUNT POLICY, which is deliberately not the
 * callback route's. The sweep credits what the requery reports, even when it
 * disagrees with what the row asked for — the gateway's own record is the
 * authoritative read, the customer may have paid a different sum, and this is
 * the only path that credits anything in production, so refusing here strands
 * a real payment forever. The single guard that remains is reconcileAction's
 * ceiling, and a refusal there must QUARANTINE: no credit, no write-off, the
 * row left where it is for a human.
 *
 * Both directions are pinned below, because both are one edit away from being
 * money bugs: fence the sweep and paid deposits stop being credited; drop the
 * ceiling and a wrong requery mints withdrawable balance.
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
  process.env.GATEWAY_ENABLED = 'true';
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
    listGatewayDeposits: jest.fn((selector: Record<string, unknown> = {}) =>
      Promise.resolve(
        selector.status === undefined || selector.status === deposit.status
          ? [deposit]
          : [],
      ),
    ),
    claimDepositStatus: jest.fn().mockResolvedValue(true),
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

    await depositReconcileJob(h.container);

    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_1', amount: 50 }),
    );
    expect(h.packs.claimDepositStatus).toHaveBeenCalledWith(
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

  // THE test this file was written for. The callback route refuses an amount
  // that is not the row's, because a callback is attacker-influenced; the
  // sweep credits it, because a requery is the gateway's own record and the
  // customer may genuinely have paid a different sum. Quarantining here would
  // leave a paid deposit with no automatic remedy at all.
  it('credits the OBSERVED amount when the requery disagrees with the row', async () => {
    const h = harness();
    fakeGateway.script({
      getDepositDetail: { state: 'success', amount: 60 },
    });

    await depositReconcileJob(h.container);

    // 60, not the row's 50 — in the ledger and in the row mirror alike.
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_1', amount: 60 }),
    );
    expect(h.packs.claimDepositStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        from: ['pending'],
        to: 'settled',
        money: expect.objectContaining({ amount_settled: 60 }),
      }),
    );
    // Settled, NOT quarantined — the discriminator between the two behaviours.
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('1 settled'),
    );
    expect(h.logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('1 quarantined'),
    );
  });

  // The guard that survives: reconcileAction's ceiling, the sweep's only
  // amount fence now. Without it a wrong requery converts 1:1 into
  // withdrawable balance.
  it('quarantines a requery above the deposit ceiling — no credit, no write-off', async () => {
    const h = harness();
    fakeGateway.script({
      getDepositDetail: { state: 'success', amount: 10001 },
    });

    await depositReconcileJob(h.container);

    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.claimDepositStatus).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('above the RM 10000 deposit ceiling'),
    );
    // Counted, not merely logged: an operator reads the summary line.
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('1 quarantined'),
    );
  });

  // The sweep's OWN quarantine branch — the one guard applyDepositOutcome
  // still applies to a requery. A malformed amount reads as NaN, which is
  // false for every `>` comparison in reconcileAction, so nothing upstream
  // stops it; without this branch it would be credited into a bigNumber
  // column. Zero takes the identical path and is scriptable.
  it('quarantines a requery that reports a non-creditable amount', async () => {
    const h = harness();
    fakeGateway.script({
      getDepositDetail: { state: 'success', amount: 0 },
    });

    await depositReconcileJob(h.container);

    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.claimDepositStatus).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/amount-not-positive/),
    );
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('1 quarantined'),
    );
  });

  it('writes a rejected deposit off through the same outcome module', async () => {
    const h = harness();
    fakeGateway.script({ getDepositDetail: { state: 'failed' } });

    await depositReconcileJob(h.container);

    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.claimDepositStatus).toHaveBeenCalledWith(
      expect.objectContaining({ from: ['pending'], to: 'failed' }),
    );
  });
});
