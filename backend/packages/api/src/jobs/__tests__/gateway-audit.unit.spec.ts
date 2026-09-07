import { fakeGateway } from '../../modules/packs/fake-gateway';
import { setActiveGateway } from '../../modules/packs/gateway';
import { GatewayError } from '../../modules/packs/gateway-types';
import gatewayAuditJob from '../gateway-audit';

// Nothing is mocked. The job requeries through the real seam — it resolves
// the active gateway, looks the config up PER ROW (rowGatewayConfigs) and
// dispatches on that config's kind — so pointing the rows at the fake
// gateway substitutes the HTTP and nothing else. Every decision under test is
// the job's own: the not-configured stamp, the ambiguous-answer skip, the
// net_amount backfill, and the finding stamp.
const ORIGINAL = { ...process.env };

beforeEach(() => {
  fakeGateway.reset();
  setActiveGateway(null);
  process.env.GATEWAY_ENABLED = 'true';
  // The fake needs no credentials; the active gateway falls back to this.
  process.env.PAYMENT_GATEWAY = 'fake';
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

const settledDeposit = {
  id: 'gpd_1',
  gateway: 'fake',
  merchant_transaction_id: 'PC-1',
  status: 'settled',
  amount_settled: '50.00',
  net_amount: null,
  created_at: new Date(),
};

function harness(
  deposits: Record<string, unknown>[],
  withdrawals: Record<string, unknown>[] = [],
) {
  const packs = {
    siteSettings: jest.fn(async () => ({ payment_gateway: null })),
    listGatewayDeposits: jest.fn(async () => deposits),
    listGatewayWithdrawals: jest.fn(async () => withdrawals),
    updateGatewayDeposits: jest.fn(async () => []),
    updateGatewayWithdrawals: jest.fn(async () => []),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const container = {
    resolve: (k: string) => (k === 'logger' ? logger : packs),
  };
  return { packs, logger, container };
}

describe('gateway audit job', () => {
  it('stamps an agreeing row with no note and backfills the net the gateway reports', async () => {
    fakeGateway.script({
      getDepositDetail: { state: 'success', amount: 50, netAmount: 49.4 },
    });
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    expect(h.packs.updateGatewayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gpd_1',
        audit_note: null,
        net_amount: 49.4,
      }),
    );
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('records a disagreement as a finding and logs it', async () => {
    fakeGateway.script({ getDepositDetail: { state: 'failed', amount: 0 } });
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    const call = (
      h.packs.updateGatewayDeposits.mock.calls as unknown[][]
    )[0][0] as {
      audit_note: string | null;
    };
    expect(call.audit_note).toMatch(/gateway/i);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it('leaves an ambiguous answer un-stamped so the next run retries it', async () => {
    fakeGateway.script({
      getDepositDetail: new GatewayError('timeout', [], 500, false),
    });
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    expect(h.packs.updateGatewayDeposits).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a row from a retired gateway is stamped as a finding, without a gateway call', async () => {
    const h = harness(
      [],
      [
        {
          id: 'gpw_1',
          gateway: 'globepay',
          merchant_transaction_id: 'PC-w1',
          status: 'settled',
          amount: '100.00',
          created_at: new Date(),
        },
      ],
    );
    await gatewayAuditJob(h.container as never);
    expect(fakeGateway.calls.withdrawalDetails).toEqual([]);
    expect(h.packs.updateGatewayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gpw_1',
        audit_note: expect.stringMatching(/not configured/),
      }),
    );
  });

  it('does nothing while the real-gateway switch is off', async () => {
    process.env.GATEWAY_ENABLED = 'false';
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    expect(h.packs.listGatewayDeposits).not.toHaveBeenCalled();
  });
});
