import { GET } from '../config/route';
import { setActiveGateway } from '../../../../modules/packs/gateway';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.PAYMENT_GATEWAY;
  process.env.GLOBEPAY_ENABLED = 'true';
  process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'true';
  process.env.GLOBEPAY_MERCHANT_CODE = 'M1';
  process.env.TGPAY_SECRET_KEY = 'sk-test';
  setActiveGateway(null);
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

function harness(setting: string | null) {
  const packs = {
    siteSettings: jest.fn(async () => ({ payment_gateway: setting })),
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
  return { req, res };
}

type Body = {
  gateway: string;
  deposits_enabled: boolean;
  withdrawals_enabled: boolean;
  deposit: { min_rm: number; max_rm: number };
  withdrawal: { min_rm: number; max_rm: number };
};

describe('GET /store/payments/config — the active gateway money bands', () => {
  it('answers with the ACTIVE gateway band, not the env default', async () => {
    const h = harness('tgpay');
    await GET(h.req as never, h.res as never);
    const body = h.res.body as Body;
    expect(body.gateway).toBe('tgpay');
    expect(body.deposit).toEqual({ min_rm: 50, max_rm: 10000 });
    expect(body.withdrawal).toEqual({ min_rm: 50, max_rm: 30000 });
    expect(body.deposits_enabled).toBe(true);
    expect(body.withdrawals_enabled).toBe(true);
    expect(h.res.headers['Cache-Control']).toBe('no-store');
  });

  it('falls back to GlobePay band when no setting is stored', async () => {
    const h = harness(null);
    await GET(h.req as never, h.res as never);
    const body = h.res.body as Body;
    expect(body.gateway).toBe('globepay');
    expect(body.deposit).toEqual({ min_rm: 30, max_rm: 10000 });
    expect(body.withdrawal).toEqual({ min_rm: 50, max_rm: 50000 });
  });

  it('reports withdrawals closed when the withdrawal switch is off', async () => {
    process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'false';
    const h = harness(null);
    await GET(h.req as never, h.res as never);
    expect((h.res.body as Body).withdrawals_enabled).toBe(false);
  });
});
