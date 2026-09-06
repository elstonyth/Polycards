import { GET, POST } from '../gateway/route';
import {
  paymentGateway,
  setActiveGateway,
} from '../../../../modules/packs/gateway';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.PAYMENT_GATEWAY;
  process.env.TGPAY_SECRET_KEY = 'sk-test';
  process.env.PAYMENT_CALLBACK_BASE = 'https://api.example';
  setActiveGateway(null);
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
    body: undefined as unknown,
    headers: {} as Record<string, string>,
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
    expect(body.gateways).toEqual([
      { id: 'tgpay', label: 'TGPay', configured: true },
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
    process.env.GLOBEPAY_NOTIFY_URL = 'https://old/hooks/globepay/deposit';
    const h = harness(null);
    h.req.body = { gateway: 'tgpay', reason: 'x' };
    await expect(POST(h.req as never, h.res as never)).rejects.toThrow(
      /callback URL/,
    );
    expect(h.packs.editPaymentGateway).not.toHaveBeenCalled();
    delete process.env.GLOBEPAY_NOTIFY_URL;
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
});
