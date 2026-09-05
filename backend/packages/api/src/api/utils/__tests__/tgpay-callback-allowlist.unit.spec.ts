import { callbackSourceIp, createTgpayCallbackAllowlist } from '../payer-ip';

const ORIGINAL = {
  TGPAY_CALLBACK_IPS: process.env.TGPAY_CALLBACK_IPS,
  TGPAY_API_BASE: process.env.TGPAY_API_BASE,
};
afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function run(req: Record<string, unknown>) {
  const logger = { warn: jest.fn() };
  const res = {
    statusCode: 0,
    body: '',
    status(code: number) {
      this.statusCode = code;
      return { send: (b: string) => void (this.body = b) };
    },
  };
  const next = jest.fn();
  createTgpayCallbackAllowlist()(
    { scope: { resolve: () => logger }, ...req } as never,
    res as never,
    next,
  );
  return { res, next, logger };
}

describe('callbackSourceIp — allowlist input', () => {
  it('takes the proxy-established address, unwraps IPv4-mapped IPv6, never the header', () => {
    expect(
      callbackSourceIp({ ip: '::ffff:1.32.102.19', socket: { remoteAddress: '10.0.0.1' } }),
    ).toBe('1.32.102.19');
    expect(callbackSourceIp({ socket: { remoteAddress: '10.0.0.9' } })).toBe('10.0.0.9');
    expect(callbackSourceIp({})).toBe('');
  });
});

describe('TGPay callback allowlist middleware', () => {
  it('lets a listed source through and refuses a foreign one with 403, logging the address', () => {
    process.env.TGPAY_API_BASE = 'https://api.example/api/v2';
    process.env.TGPAY_CALLBACK_IPS = '1.32.102.19, 54.251.58.7';
    const ok = run({ ip: '::ffff:54.251.58.7' });
    expect(ok.next).toHaveBeenCalled();
    // A spoofed forwarded header changes nothing: it is never read.
    const bad = run({ ip: '9.9.9.9', headers: { 'x-forwarded-for': '1.32.102.19' } });
    expect(bad.next).not.toHaveBeenCalled();
    expect(bad.res.statusCode).toBe(403);
    expect(bad.res.body).toBe('rejected');
    expect(bad.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/rejected callback from 9\.9\.9\.9: not-listed/),
    );
  });

  it('production without a list refuses (misconfiguration, not a mode); the sandbox passes header-only', () => {
    delete process.env.TGPAY_CALLBACK_IPS;
    process.env.TGPAY_API_BASE = 'https://api.example/api/v2';
    const prod = run({ ip: '1.32.102.19' });
    expect(prod.res.statusCode).toBe(403);
    expect(prod.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/unset-in-production/),
    );
    process.env.TGPAY_API_BASE = 'https://sandbox-api.example/api/v2';
    const sandbox = run({ ip: '9.9.9.9' });
    expect(sandbox.next).toHaveBeenCalled();
  });
});
