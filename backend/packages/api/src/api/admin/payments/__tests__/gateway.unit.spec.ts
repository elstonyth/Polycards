import { GET, POST } from '../gateway/route';
import {
  paymentGateway,
  setActiveGateway,
} from '../../../../modules/packs/gateway';

const ORIGINAL = { ...process.env };
const originalFetch = global.fetch;

/** The gateway's wallet endpoints, as the live check sees them. */
function stubWallets(
  reply: { status: number; body: unknown } | ((url: string) => { status: number; body: unknown }),
) {
  const calls: string[] = [];
  global.fetch = jest.fn(async (url: string) => {
    calls.push(url);
    const r = typeof reply === 'function' ? reply(url) : reply;
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  }) as unknown as typeof fetch;
  return calls;
}
const wallet = (balance: number) => ({
  status: 200,
  body: { status: 1, msg: 'Success', data: { balance, currency: { code: 'MYR', name: 'Malaysia Ringgit' } } },
});

beforeEach(() => {
  delete process.env.PAYMENT_GATEWAY;
  process.env.TGPAY_SECRET_KEY = 'sk-test';
  process.env.TGPAY_PUBLIC_KEY = 'pk-test';
  process.env.TGPAY_API_BASE = 'https://sandbox-api.example/api/v2';
  delete process.env.THE7PAY_SECRET_KEY;
  process.env.PAYMENT_CALLBACK_BASE = 'https://api.example';
  delete process.env.GATEWAY_WITHDRAWALS_ENABLED;
  setActiveGateway(null);
  // Default: the live check passes (both wallets answer).
  stubWallets(wallet(100));
});

afterEach(() => {
  global.fetch = originalFetch;
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

function harness(setting: string | null) {
  const packs = {
    siteSettings: jest.fn(async () => ({ payment_gateway: setting })),
    editPaymentGateway: jest.fn(async (input: { gateway: string }) => ({
      payment_gateway: input.gateway,
    })),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const req = {
    body: {},
    auth_context: { actor_id: 'admin_1' },
    scope: { resolve: (k: string) => (k === 'logger' ? logger : packs) },
  };
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    json(payload: unknown) {
      this.body = payload;
    },
  };
  return { packs, logger, req, res };
}

describe('GET /admin/payments/gateway', () => {
  it('reports the active gateway, the persisted setting, and which gateways are configured', async () => {
    const h = harness('tgpay');
    await GET(h.req as never, h.res as never);
    const body = h.res.body as {
      active: string;
      setting: string | null;
      gateways: { id: string; configured: boolean }[];
    };
    expect(body.active).toBe('tgpay');
    expect(body.setting).toBe('tgpay');
    // The 7 Pay is listed but not choosable until THE7PAY_SECRET_KEY is set.
    expect(body.gateways).toEqual([
      { id: 'tgpay', label: 'TGPay', configured: true },
      { id: 'the7pay', label: 'The 7 Pay', configured: false },
    ]);
    expect(h.res.headers['Cache-Control']).toBe('no-store');
  });
});

describe('POST /admin/payments/gateway', () => {
  it('persists, audits with the reason, and flips the in-process cache at once', async () => {
    const h = harness(null);
    h.req.body = { gateway: 'tgpay', reason: 'cutover day' };
    await POST(h.req as never, h.res as never);
    expect(h.packs.editPaymentGateway).toHaveBeenCalledWith({
      gateway: 'tgpay',
      adminId: 'admin_1',
      reason: 'cutover day',
    });
    expect(paymentGateway({})).toBe('tgpay');
    expect((h.res.body as { active: string }).active).toBe('tgpay');
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/switched .* to tgpay/),
    );
  });

  it('refuses a gateway whose callbacks could not reach us', async () => {
    delete process.env.PAYMENT_CALLBACK_BASE;
    process.env.GATEWAY_NOTIFY_URL = 'https://old/hooks/x/deposit';
    const h = harness(null);
    h.req.body = { gateway: 'tgpay', reason: 'x' };
    await expect(POST(h.req as never, h.res as never)).rejects.toThrow(
      /callback URL/,
    );
    expect(h.packs.editPaymentGateway).not.toHaveBeenCalled();
    delete process.env.GATEWAY_NOTIFY_URL;
  });

  it('refuses a gateway whose config is incomplete (one key set, no base URL)', async () => {
    process.env.THE7PAY_SECRET_KEY = 'sk-7';
    const h = harness(null);
    h.req.body = { gateway: 'the7pay', reason: 'tgpay down' };
    await expect(POST(h.req as never, h.res as never)).rejects.toThrow(
      /The 7 Pay is not fully configured .*THE7PAY_API_BASE/,
    );
    expect(h.packs.editPaymentGateway).not.toHaveBeenCalled();
  });

  it('refuses a gateway with no callback URL in this environment', async () => {
    delete process.env.PAYMENT_CALLBACK_BASE;
    const h = harness(null);
    h.req.body = { gateway: 'tgpay', reason: 'x' };
    await expect(POST(h.req as never, h.res as never)).rejects.toThrow(
      /callback URL/,
    );
    expect(h.packs.editPaymentGateway).not.toHaveBeenCalled();
  });

  it('refuses an unknown or retired gateway, an unconfigured one, and a missing reason — without writing', async () => {
    const configured = process.env.TGPAY_SECRET_KEY;
    for (const [body, env] of [
      [{ gateway: 'stripe', reason: 'x' }, {}],
      [{ gateway: 'globepay', reason: 'x' }, {}],
      [{ gateway: 'tgpay', reason: 'x' }, { TGPAY_SECRET_KEY: undefined }],
      [{ gateway: 'tgpay' }, {}],
    ] as const) {
      if ('TGPAY_SECRET_KEY' in env) delete process.env.TGPAY_SECRET_KEY;
      const h = harness(null);
      h.req.body = body;
      await expect(POST(h.req as never, h.res as never)).rejects.toThrow();
      expect(h.packs.editPaymentGateway).not.toHaveBeenCalled();
      process.env.TGPAY_SECRET_KEY = configured;
    }
    expect(paymentGateway({})).toBe('tgpay');
  });

  // The live check (2026-10-09): The 7 Pay had valid keys but refused our
  // server's IP until whitelisted — a switch then would have failed every
  // top-up. Filled-in settings are not proof the gateway will serve us.
  describe('live check before switching', () => {
    it('refuses with the gateway\'s own answer when it will not serve us, and writes nothing', async () => {
      stubWallets({
        status: 403,
        body: { statusCode: 403, message: 'Request IP is not allowed for this tenant', error: 'Forbidden' },
      });
      const h = harness(null);
      h.req.body = { gateway: 'tgpay', reason: 'tgpay test' };
      await POST(h.req as never, h.res as never);
      expect(h.res.statusCode).toBe(422);
      const body = h.res.body as { type: string; problems: string[]; can_force: boolean };
      expect(body.type).toBe('gateway_preflight_failed');
      expect(body.can_force).toBe(true);
      expect(body.problems[0]).toMatch(/^TGPay did not accept a test call from our server: .*Request IP is not allowed/);
      expect(h.packs.editPaymentGateway).not.toHaveBeenCalled();
    });

    it('lets the operator force it, and records what was overridden in the audit reason', async () => {
      stubWallets({ status: 403, body: { statusCode: 403, message: 'Request IP is not allowed for this tenant' } });
      const h = harness(null);
      h.req.body = { gateway: 'tgpay', reason: 'tgpay down, emergency', force: true };
      await POST(h.req as never, h.res as never);
      expect(h.res.statusCode).toBe(200);
      const call = h.packs.editPaymentGateway.mock.calls[0][0] as unknown as { reason: string };
      expect(call.reason).toMatch(/^tgpay down, emergency \[switched despite: TGPay did not accept/);
      expect(call.reason.length).toBeLessThanOrEqual(500);
      expect(paymentGateway({})).toBe('tgpay');
      expect(h.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/FORCED past the live check/));
    });

    it('refuses The 7 Pay in production while its callback allowlist is unset; passes once it is set', async () => {
      process.env.THE7PAY_SECRET_KEY = 'sk-7';
      process.env.THE7PAY_PUBLIC_KEY = 'pk-7';
      process.env.THE7PAY_API_BASE = 'https://api.the7pay.test/api/v1';
      delete process.env.THE7PAY_CALLBACK_IPS;
      const calls = stubWallets(wallet(250));
      const h = harness(null);
      h.req.body = { gateway: 'the7pay', reason: 'standby test' };
      await POST(h.req as never, h.res as never);
      expect(calls.some((u) => u.startsWith('https://api.the7pay.test/api/v1/'))).toBe(true);
      expect(h.res.statusCode).toBe(422);
      expect((h.res.body as { problems: string[] }).problems).toEqual([
        expect.stringMatching(/^THE7PAY_CALLBACK_IPS is not set — The 7 Pay's payment callbacks would be refused/),
      ]);
      expect(h.packs.editPaymentGateway).not.toHaveBeenCalled();

      process.env.THE7PAY_CALLBACK_IPS = '1.2.3.4';
      const h2 = harness(null);
      h2.req.body = { gateway: 'the7pay', reason: 'standby test' };
      await POST(h2.req as never, h2.res as never);
      expect(h2.res.statusCode).toBe(200);
      expect((h2.res.body as { active: string; warnings: string[] })).toMatchObject({ active: 'the7pay', warnings: [] });
      setActiveGateway(null);
    });

    it('switches but warns when the payout wallet is empty and withdrawals are on', async () => {
      process.env.GATEWAY_WITHDRAWALS_ENABLED = 'true';
      stubWallets((url) => wallet(url.includes('payout') ? 0 : 500));
      const h = harness(null);
      h.req.body = { gateway: 'tgpay', reason: 'wallet check' };
      await POST(h.req as never, h.res as never);
      expect(h.res.statusCode).toBe(200);
      expect((h.res.body as { warnings: string[] }).warnings).toEqual([
        expect.stringMatching(/^TGPay payout wallet is MYR 0\.00 — withdrawals will be refused/),
      ]);
      expect(h.packs.editPaymentGateway).toHaveBeenCalled();
    });
  });
});
