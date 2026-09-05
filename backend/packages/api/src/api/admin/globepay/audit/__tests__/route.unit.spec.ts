jest.mock('../../../../../modules/packs/gateway', () => {
  const actual = jest.requireActual('../../../../../modules/packs/gateway');
  return { ...actual, checkBalance: jest.fn(), gatewayConfigFor: jest.fn() };
});

import { GET } from '../route';
import {
  checkBalance,
  gatewayConfigFor,
  setActiveGateway,
} from '../../../../../modules/packs/gateway';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.PAYMENT_GATEWAY;
  process.env.GLOBEPAY_ENABLED = 'true';
  process.env.GLOBEPAY_MERCHANT_CODE = 'M1';
  process.env.TGPAY_SECRET_KEY = 'sk-test';
  setActiveGateway(null);
  jest.clearAllMocks();
  (gatewayConfigFor as jest.Mock).mockImplementation((id: string) => ({ id }));
  (checkBalance as jest.Mock).mockResolvedValue({
    currentBalance: 300,
    availableBalance: 249,
    currencyCode: 'MYR',
    notes: [],
  });
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

const zero = { count: 0, grossCents: 0, netCents: 0, missingNet: 0 };
function totals(gateway: string) {
  if (gateway === 'globepay') {
    return {
      deposits: { count: 2, grossCents: 10000, netCents: 9800, missingNet: 0 },
      withdrawals: {
        count: 1,
        grossCents: 5000,
        netCents: 4950,
        missingNet: 0,
      },
      findings: 1,
      lastAuditedAt: '2026-09-06T00:00:00.000Z',
    };
  }
  return {
    deposits: zero,
    withdrawals: zero,
    findings: 1,
    lastAuditedAt: null,
  };
}

function harness(setting: string | null) {
  const packs = {
    siteSettings: jest.fn(async () => ({ payment_gateway: setting })),
    gatewayAuditTotals: jest.fn(async (g: string) => totals(g)),
    listGlobePayDeposits: jest.fn(async () => [
      {
        id: 'd1',
        gateway: 'globepay',
        merchant_transaction_id: 'PC-1',
        gateway_transaction_id: 'G1',
        customer_id: 'cus_1',
        status: 'settled',
        amount_settled: '50.00',
        amount_requested: '50.00',
        audit_note: 'gateway says failed',
        audited_at: new Date('2026-09-06T00:00:00Z'),
      },
    ]),
    listGlobePayWithdrawals: jest.fn(async () => []),
  };
  const req = { scope: { resolve: () => packs } };
  const res = {
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    json(payload: unknown) {
      this.body = payload;
    },
  };
  return { packs, req, res };
}

type Body = {
  gateway: string;
  wallet: { current: number; available: number } | null;
  wallet_error: string | null;
  totals: { deposits: { count: number; gross: number; net: number } };
  history: { gateway: string; deposits: { count: number; gross: number } }[];
  findings: { kind: string; gateway: string; amount: number | null }[];
};

describe('GET /admin/globepay/audit', () => {
  it('reads the ACTIVE gateway wallet and totals, and lists the other gateway history', async () => {
    const h = harness('tgpay');
    await GET(h.req as never, h.res as never);
    const body = h.res.body as Body;
    expect(body.gateway).toBe('tgpay');
    expect(gatewayConfigFor).toHaveBeenCalledWith('tgpay');
    expect(body.wallet).toEqual(
      expect.objectContaining({ current: 300, available: 249 }),
    );
    expect(body.totals.deposits.count).toBe(0);
    expect(body.history).toEqual([
      expect.objectContaining({
        gateway: 'globepay',
        deposits: expect.objectContaining({ count: 2, gross: 100, net: 98 }),
      }),
    ]);
    expect(body.findings[0]).toEqual(
      expect.objectContaining({
        kind: 'deposit',
        gateway: 'globepay',
        amount: 50,
      }),
    );
  });

  it('a wallet read failure is reported beside the findings, never instead of them', async () => {
    (checkBalance as jest.Mock).mockRejectedValue(new Error('403 not allowed'));
    const h = harness(null);
    await GET(h.req as never, h.res as never);
    const body = h.res.body as Body;
    expect(body.wallet).toBeNull();
    expect(body.wallet_error).toMatch(/403/);
    expect(body.findings).toHaveLength(1);
    expect(body.history).toEqual([]);
  });
});
