import * as fs from 'fs';
import * as path from 'path';
import {
  callbackSourceIp,
  createA3payCallbackAllowlist,
  createTgpayCallbackAllowlist,
} from '../payer-ip';
import { GATEWAYS, GATEWAY_IDS } from '../../../modules/packs/gateway';
import {
  extractLimiterEntries,
  matcherToRegExp,
} from '../../__tests__/rate-limit-coverage-helpers';

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

function run(
  req: Record<string, unknown>,
  allowlist: ReturnType<
    typeof createTgpayCallbackAllowlist
  > = createTgpayCallbackAllowlist(),
) {
  const logger = { warn: jest.fn(), info: jest.fn() };
  const res = {
    statusCode: 0,
    body: '',
    status(code: number) {
      this.statusCode = code;
      return { send: (b: string) => void (this.body = b) };
    },
  };
  const next = jest.fn();
  allowlist(
    { scope: { resolve: () => logger }, ...req } as never,
    res as never,
    next,
  );
  return { res, next, logger };
}

describe('callbackSourceIp — allowlist input', () => {
  it('prefers the App Platform ingress header, then req.ip, unwrapping IPv4-mapped IPv6 — never x-forwarded-for', () => {
    // On App Platform req.ip is the DigitalOcean ingress; the client is in
    // do-connecting-ip.
    expect(
      callbackSourceIp({
        ip: '10.244.0.7',
        headers: {
          'do-connecting-ip': '54.251.58.7',
          'x-forwarded-for': '9.9.9.9',
        },
      }),
    ).toBe('54.251.58.7');
    expect(
      callbackSourceIp({
        ip: '::ffff:1.32.102.19',
        socket: { remoteAddress: '10.0.0.1' },
      }),
    ).toBe('1.32.102.19');
    expect(callbackSourceIp({ socket: { remoteAddress: '10.0.0.9' } })).toBe(
      '10.0.0.9',
    );
    expect(callbackSourceIp({})).toBe('');
  });
});

describe('TGPay callback allowlist middleware', () => {
  it('lets a listed source through and refuses a foreign one with 403, logging the address', () => {
    process.env.TGPAY_API_BASE = 'https://api.example/api/v2';
    process.env.TGPAY_CALLBACK_IPS = '1.32.102.19, 54.251.58.7';
    const ok = run({ ip: '::ffff:54.251.58.7' });
    expect(ok.next).toHaveBeenCalled();
    expect(ok.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/callback from 54\.251\.58\.7 accepted/),
    );
    // App Platform shape: ingress in req.ip, client in do-connecting-ip.
    const viaIngress = run({
      ip: '10.244.0.7',
      headers: { 'do-connecting-ip': '1.32.102.19' },
    });
    expect(viaIngress.next).toHaveBeenCalled();
    // A spoofed forwarded header changes nothing: it is never read.
    const bad = run({
      ip: '9.9.9.9',
      headers: { 'x-forwarded-for': '1.32.102.19' },
    });
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

describe('wiring — every gateway hook path carries the limiter AND the allowlist', () => {
  // The allowlist above is tested in isolation — it never reads middlewares.ts.
  // Rename a hook path, reorder the array, or drop the entry in a refactor and
  // production reverts to header-only callback authentication with a green
  // suite unless something reads the actual wiring. This does.
  it('middlewares.ts has an entry matching each GATEWAYS[id].hooks path with both middlewares', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../middlewares.ts'),
      'utf8',
    );
    const entries = extractLimiterEntries(src).map((e) => ({
      ...e,
      re: matcherToRegExp(e.matcher),
    }));
    for (const id of GATEWAY_IDS) {
      for (const hookPath of Object.values(GATEWAYS[id].hooks)) {
        const hit = entries.find(
          (e) => e.methods.includes('POST') && e.re.test(hookPath),
        );
        // Jest's expect() takes exactly one argument — no message param —
        // so the "which path" context comes from the thrown message instead.
        if (!hit) throw new Error(`${hookPath} has no POST middleware entry`);
        expect(hit.middlewares).toMatch(/\bgatewayHookRateLimit\b/);
        // Each gateway's OWN list (createTgpayCallbackAllowlist(id)).
        expect(hit.middlewares).toMatch(
          new RegExp(`\\b${id}CallbackAllowlist\\b`),
        );
      }
    }
  });

  it('the bare /hooks/tgpay prefix (no trailing segment) does not match the hook matcher', () => {
    // The matcher note at middlewares.ts:311-317 (verified against a booted
    // express app) records that '/hooks/tgpay/*' compiles to
    // /^\/hooks\/tgpay\/(.*)\/?$/i — it must NOT match the bare prefix.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../middlewares.ts'),
      'utf8',
    );
    const entries = extractLimiterEntries(src).map((e) => ({
      ...e,
      re: matcherToRegExp(e.matcher),
    }));
    expect(
      entries.some(
        (e) => e.methods.includes('POST') && e.re.test('/hooks/tgpay'),
      ),
    ).toBe(false);
  });
});

describe('createA3payCallbackAllowlist — same middleware, A3Pay rule', () => {
  it("passes A3Pay's documented address by default and refuses any other", () => {
    const ok = run({ ip: '13.192.222.226' }, createA3payCallbackAllowlist({}));
    expect(ok.next).toHaveBeenCalled();
    expect(ok.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[a3pay] callback from 13.192.222.226 accepted'),
    );
    const bad = run({ ip: '9.9.9.9' }, createA3payCallbackAllowlist({}));
    expect(bad.next).not.toHaveBeenCalled();
    expect(bad.res.statusCode).toBe(403);
    expect(bad.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[a3pay] rejected callback from 9.9.9.9: not-listed'),
    );
  });

  it('a set list replaces the default; one with no valid entry refuses everything', () => {
    const local = createA3payCallbackAllowlist({ A3PAY_CALLBACK_IPS: '127.0.0.1' });
    expect(run({ ip: '127.0.0.1' }, local).next).toHaveBeenCalled();
    expect(run({ ip: '13.192.222.226' }, local).res.statusCode).toBe(403);
    const junk = run(
      { ip: '13.192.222.226' },
      createA3payCallbackAllowlist({ A3PAY_CALLBACK_IPS: 'not-an-ip' }),
    );
    expect(junk.res.statusCode).toBe(403);
    expect(junk.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/A3PAY_CALLBACK_IPS has no valid entries/),
    );
  });
});

describe('createA3payCallbackAllowlist for GlobePay365 — its own address list', () => {
  it("passes GlobePay365's production address by default, not A3Pay's", () => {
    const gp = createA3payCallbackAllowlist({}, 'gp365');
    const ok = run({ ip: '13.159.14.239' }, gp);
    expect(ok.next).toHaveBeenCalled();
    expect(ok.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[gp365] callback from 13.159.14.239 accepted'),
    );
    expect(run({ ip: '13.192.222.226' }, gp).res.statusCode).toBe(403);
  });

  it('GP365_CALLBACK_IPS replaces it (staging: 160.250.92.219); A3PAY_CALLBACK_IPS does not', () => {
    const staging = createA3payCallbackAllowlist(
      { GP365_CALLBACK_IPS: '160.250.92.219' },
      'gp365',
    );
    expect(run({ ip: '160.250.92.219' }, staging).next).toHaveBeenCalled();
    expect(run({ ip: '13.159.14.239' }, staging).res.statusCode).toBe(403);
    const crossed = createA3payCallbackAllowlist(
      { A3PAY_CALLBACK_IPS: '160.250.92.219' },
      'gp365',
    );
    expect(run({ ip: '160.250.92.219' }, crossed).res.statusCode).toBe(403);
  });
});
