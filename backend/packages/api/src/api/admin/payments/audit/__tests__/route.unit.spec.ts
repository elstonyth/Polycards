import { GET } from '../route';
import { setActiveGateway } from '../../../../../modules/packs/gateway';
import { fakeGateway } from '../../../../../modules/packs/fake-gateway';
import type {
  FakeFacet,
  GatewayReports,
} from '../../../../../modules/packs/facets';
import type PacksModuleService from '../../../../../modules/packs/service';

// The wallet read runs through the REAL seam: the route resolves the active
// gateway, asks gatewayConfigFor for its config and calls checkBalance, which
// dispatches on that config's kind. Selecting the fake gateway is therefore
// the whole substitution — nothing here replaces a module.
const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.PAYMENT_GATEWAY;
  process.env.GATEWAY_ENABLED = 'true';
  process.env.TGPAY_SECRET_KEY = 'sk-test';
  setActiveGateway(null);
  jest.clearAllMocks();
  fakeGateway.reset();
  fakeGateway.script({
    checkBalance: {
      currentBalance: 300,
      availableBalance: 249,
      currencyCode: 'MYR',
      notes: [],
    },
  });
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

const zero = {
  count: 0,
  grossCents: 0,
  netCents: 0,
  missingNet: 0,
  missingGross: 0,
};
function totals(gateway: string) {
  if (gateway === 'globepay') {
    return {
      deposits: {
        count: 2,
        grossCents: 10000,
        netCents: 9800,
        missingNet: 0,
        // One hand-settled row with no amount_settled — gross is a FLOOR
        // (plan 133).
        missingGross: 1,
      },
      withdrawals: {
        count: 1,
        grossCents: 5000,
        netCents: 4950,
        missingNet: 0,
        missingGross: 0,
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
    listGatewayDeposits: jest.fn(async () => [
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
    listGatewayWithdrawals: jest.fn(async () => []),
    // siteSettings is outside the route’s facet: resolveActiveGateway
    // resolves the service itself, from the same scope this fake serves.
  } satisfies FakeFacet<
    GatewayReports & Pick<PacksModuleService, 'siteSettings'>
  >;
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
  history: {
    gateway: string;
    deposits: { count: number; gross: number; missing_gross: number };
  }[];
  findings: { kind: string; gateway: string; amount: number | null }[];
};

describe('GET /admin/payments/audit', () => {
  it('reads the ACTIVE gateway wallet and totals, and lists the other gateway history', async () => {
    // Active by the ADMIN SETTING alone — PAYMENT_GATEWAY is unset here.
    const h = harness('fake');
    await GET(h.req as never, h.res as never);
    const body = h.res.body as Body;
    expect(body.gateway).toBe('fake');
    // The wallet came from the ACTIVE gateway's own config: only that
    // gateway's adapter was ever asked.
    expect(fakeGateway.calls.balances).toEqual([{ kind: 'fake' }]);
    expect(body.wallet).toEqual(
      expect.objectContaining({ current: 300, available: 249 }),
    );
    expect(body.totals.deposits.count).toBe(0);
    expect(body.history).toEqual([
      expect.objectContaining({
        gateway: 'globepay',
        // missing_gross rides through with the rest — the panel needs it to
        // say "gross is a floor" on a retired gateway too (plan 133).
        deposits: expect.objectContaining({
          count: 2,
          gross: 100,
          net: 98,
          missing_gross: 1,
        }),
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
    fakeGateway.script({
      checkBalance: new Error('403 not allowed'),
    });
    // No admin setting: the active gateway falls back to PAYMENT_GATEWAY.
    process.env.PAYMENT_GATEWAY = 'fake';
    const h = harness(null);
    await GET(h.req as never, h.res as never);
    const body = h.res.body as Body;
    expect(body.wallet).toBeNull();
    expect(body.wallet_error).toMatch(/403/);
    expect(body.findings).toHaveLength(1);
    // The retired gateway's settled history is still listed.
    expect(body.history.map((h) => h.gateway)).toEqual(['globepay']);
  });
});
