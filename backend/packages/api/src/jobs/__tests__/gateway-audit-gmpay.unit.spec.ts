import { setActiveGateway } from '../../modules/packs/gateway';
import gatewayAuditJob from '../gateway-audit';

// GMpay can be asked about a payment by its own token only. A row whose
// create never returned one has nothing at GMpay to compare, and must leave
// the never-checked queue instead of being skipped as unclear every run.
const ORIGINAL = { ...process.env };

beforeEach(() => {
  setActiveGateway(null);
  Object.assign(process.env, {
    GATEWAY_ENABLED: 'true',
    PAYMENT_GATEWAY: 'fake',
    GMPAY_API_BASE: 'https://xapi.example.test/v3',
    GMPAY_CLIENT_ID: 'client-1',
    GMPAY_SECRET_KEY: 'secret',
  });
});

afterEach(() => jest.restoreAllMocks());

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

function harness(
  deposits: Record<string, unknown>[],
  withdrawals: Record<string, unknown>[] = [],
) {
  const packs = {
    siteSettings: jest.fn(async () => ({ payment_gateway: null })),
    listGatewayDeposits: jest.fn(async (f: { audited_at?: unknown }) =>
      f.audited_at === null ? deposits : [],
    ),
    listGatewayWithdrawals: jest.fn(async (f: { audited_at?: unknown }) =>
      f.audited_at === null ? withdrawals : [],
    ),
    updateGatewayDeposits: jest.fn(async () => []),
    updateGatewayWithdrawals: jest.fn(async () => []),
    listCreditTransactions: jest.fn(async (): Promise<unknown[]> => []),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const container = {
    resolve: (k: string) => (k === 'logger' ? logger : packs),
  };
  return { packs, logger, container };
}

const refused = {
  id: 'gpd_g1',
  gateway: 'gmpay',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-G1',
  gateway_transaction_id: null,
  status: 'failed',
  amount_requested: '319',
  amount_settled: null,
  net_amount: null,
  currency: 'SGD',
  gateway_amount: '100',
  created_at: new Date(),
};

describe('gateway audit, GMpay rows without their token', () => {
  it('stamps a refused create clean without asking GMpay', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const h = harness([refused]);
    await gatewayAuditJob(h.container as never);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.packs.updateGatewayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gpd_g1', audit_note: null }),
    );
  });

  it('makes a settled one a finding: GMpay can never confirm it', async () => {
    jest.spyOn(global, 'fetch');
    const h = harness([
      { ...refused, status: 'settled', amount_settled: '319' },
    ]);
    await gatewayAuditJob(h.container as never);
    expect(h.packs.updateGatewayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gpd_g1',
        audit_note: expect.stringMatching(/without the gateway id/),
      }),
    );
  });

  it('still asks GMpay about a row that has its token', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status_code: 0,
          tran_token: 'tok-1',
          tran_unique: 'PC-G1',
          tran_amount: 100,
          tran_status: 'expired',
        }),
        { status: 200 },
      ),
    );
    const h = harness([{ ...refused, gateway_transaction_id: 'tok-1' }]);
    await gatewayAuditJob(h.container as never);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(h.packs.updateGatewayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gpd_g1', audit_note: null }),
    );
  });
});
