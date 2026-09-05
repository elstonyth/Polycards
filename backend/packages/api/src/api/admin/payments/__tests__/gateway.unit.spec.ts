import { GET, POST } from '../gateway/route';
import {
  paymentGateway,
  setActiveGateway,
} from '../../../../modules/packs/gateway';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.PAYMENT_GATEWAY;
  delete process.env.GLOBEPAY_MERCHANT_CODE;
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
      { id: 'globepay', label: 'GlobePay365', configured: false },
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

  it('requires the payout-verify URL too, for a gateway that has that step, when withdrawals are on', async () => {
    delete process.env.PAYMENT_CALLBACK_BASE;
    process.env.GLOBEPAY_MERCHANT_CODE = 'Testpolycard';
    process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'true';
    process.env.GLOBEPAY_NOTIFY_URL = 'https://old/hooks/globepay/deposit';
    process.env.GLOBEPAY_WITHDRAW_NOTIFY_URL =
      'https://old/hooks/globepay/withdrawal';
    delete process.env.GLOBEPAY_PAYOUT_VERIFY_URL;
    const h = harness(null);
    h.req.body = { gateway: 'globepay', reason: 'x' };
    await expect(POST(h.req as never, h.res as never)).rejects.toThrow(
      /callback URL/,
    );
    expect(h.packs.editPaymentGateway).not.toHaveBeenCalled();
    delete process.env.GLOBEPAY_WITHDRAWALS_ENABLED;
    delete process.env.GLOBEPAY_NOTIFY_URL;
    delete process.env.GLOBEPAY_WITHDRAW_NOTIFY_URL;
  });

  it('refuses an unknown gateway, an unconfigured one, and a missing reason — without writing', async () => {
    for (const body of [
      { gateway: 'stripe', reason: 'x' },
      { gateway: 'globepay', reason: 'x' },
      { gateway: 'tgpay' },
    ]) {
      const h = harness(null);
      h.req.body = body;
      await expect(POST(h.req as never, h.res as never)).rejects.toThrow();
      expect(h.packs.editPaymentGateway).not.toHaveBeenCalled();
    }
    expect(paymentGateway({})).toBe('globepay');
  });
});
