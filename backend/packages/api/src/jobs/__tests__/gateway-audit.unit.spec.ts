// The gateway seam is the only thing mocked; every decision under test is
// the job's own: per-row gateway config, the not-configured stamp, the
// ambiguous-answer skip, the net_amount backfill, and the finding stamp.
jest.mock('../../modules/packs/gateway', () => {
  const actual = jest.requireActual('../../modules/packs/gateway');
  return {
    ...actual,
    getDepositDetail: jest.fn(),
    getWithdrawalDetail: jest.fn(),
    resolveActiveGateway: jest.fn(async () => 'tgpay'),
  };
});

import {
  getDepositDetail,
  getWithdrawalDetail,
} from '../../modules/packs/gateway';
import { GatewayError } from '../../modules/packs/gateway-types';
import gatewayAuditJob from '../gateway-audit';

const depositDetail = getDepositDetail as jest.Mock;
const withdrawalDetail = getWithdrawalDetail as jest.Mock;

beforeEach(() => {
  depositDetail.mockReset();
  withdrawalDetail.mockReset();
  process.env.GLOBEPAY_ENABLED = 'true';
  process.env.TGPAY_API_BASE = 'https://sandbox-api.example.test/api/v2';
  process.env.TGPAY_PUBLIC_KEY = 'pk-test';
  process.env.TGPAY_SECRET_KEY = 'sk-test';
});

const settledDeposit = {
  id: 'gpd_1',
  gateway: 'tgpay',
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
    listGlobePayDeposits: jest.fn(async () => deposits),
    listGlobePayWithdrawals: jest.fn(async () => withdrawals),
    updateGlobePayDeposits: jest.fn(async () => []),
    updateGlobePayWithdrawals: jest.fn(async () => []),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const container = {
    resolve: (k: string) => (k === 'logger' ? logger : packs),
  };
  return { packs, logger, container };
}

describe('gateway audit job', () => {
  it('stamps an agreeing row with no note and backfills the net the gateway reports', async () => {
    depositDetail.mockResolvedValue({
      state: 'success',
      amount: 50,
      netAmount: 49.4,
    });
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gpd_1',
        audit_note: null,
        net_amount: 49.4,
      }),
    );
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('records a disagreement as a finding and logs it', async () => {
    depositDetail.mockResolvedValue({ state: 'failed', amount: 0 });
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    const call = (
      h.packs.updateGlobePayDeposits.mock.calls as unknown[][]
    )[0][0] as {
      audit_note: string | null;
    };
    expect(call.audit_note).toMatch(/gateway/i);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });

  it('leaves an ambiguous answer un-stamped so the next run retries it', async () => {
    depositDetail.mockRejectedValue(
      new GatewayError('timeout', [], 500, false),
    );
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    expect(h.packs.updateGlobePayDeposits).not.toHaveBeenCalled();
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
    expect(withdrawalDetail).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gpw_1',
        audit_note: expect.stringMatching(/not configured/),
      }),
    );
  });

  it('does nothing while the real-gateway switch is off', async () => {
    process.env.GLOBEPAY_ENABLED = 'false';
    const h = harness([settledDeposit]);
    await gatewayAuditJob(h.container as never);
    expect(h.packs.listGlobePayDeposits).not.toHaveBeenCalled();
  });
});
