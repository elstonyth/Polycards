import { POST as startVerification } from '../route';
import * as phoneUtils from '../../../../../utils/phone-verification';
import * as rateLimit from '../../../../utils/rate-limit';

// Only the transport is mocked. `isAllowedSmsDestination` stays REAL — it is the
// thing under test here, and stubbing it is exactly the red-green probe (see the
// plan's test plan: stubbing it true must make the refusal case fail).
jest.mock('../../../../../utils/phone-verification', () => ({
  ...jest.requireActual('../../../../../utils/phone-verification'),
  sendPhoneOtp: jest.fn(async () => undefined),
}));

jest.mock('../../../../utils/rate-limit', () => ({
  consumeOtpSendBudget: jest.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
}));

const sendPhoneOtp = phoneUtils.sendPhoneOtp as jest.Mock;
const consumeOtpSendBudget = rateLimit.consumeOtpSendBudget as jest.Mock;

// Assert on the CALL COUNT, not on the mock itself. The route passes
// `process.env` as sendPhoneOtp's first argument, so a failing
// `expect(sendPhoneOtp).not.toHaveBeenCalled()` pretty-prints every recorded
// argument — i.e. the entire environment, API keys included — into the CI log.
// A number can't leak anything.
const sendCount = () => sendPhoneOtp.mock.calls.length;

const MY = '+60107667787';
const GB = '+442079460958';

const mkRes = () => {
  const out: { body?: unknown; status?: number; retry?: string } = {};
  const res = {
    json: (b: unknown) => (out.body = b),
    status: (status: number) => { out.status = status; return res; },
    set: (_name: string, value: string) => { out.retry = value; return res; },
  };
  return { res: res as never, out };
};

const warn = jest.fn();
const error = jest.fn();
// `matches` is what listCustomers returns for the password-reset lookup: one
// row means "exactly one account carries this phone", the only case that sends.
const mkReq = (phone: string, purpose = 'signup', matches: unknown[] = [{ id: 'cus_1' }], channel?: 'sms' | 'call') =>
  ({
    body: { phone, purpose, channel },
    scope: {
      resolve: (key: string) =>
        key === 'logger'
          ? { warn, error }
          : { listCustomers: jest.fn(async () => matches) },
    },
  }) as never;

beforeEach(() => {
  warn.mockReset();
  error.mockReset();
  sendPhoneOtp.mockClear();
  consumeOtpSendBudget.mockClear();
});

describe('POST /store/phone-verification/start — destination allowlist', () => {
  it('sends to a served destination', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(MY), res);
    expect(sendCount()).toBe(1);
    expect(out.body).toEqual({ ok: true, channel: 'sms' });
  });

  // The whole point: this route is unauthenticated and every call bills an SMS.
  it('refuses an unserved destination without sending, and says nothing about it', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(GB), res);

    expect(sendCount()).toBe(0);
    // Byte-identical to the success shape above and to the silent
    // password-reset branch — a distinct error would be a country-probe oracle.
    expect(out.body).toEqual({ ok: true, channel: 'sms' });
  });

  it('logs the calling-code prefix only, never the number', async () => {
    await startVerification(mkReq(GB), mkRes().res);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('+44');
    expect(line).not.toContain(GB);
  });

  // password-reset is exempt: it already refuses unless exactly one registered
  // account carries the number, so it can only text a phone already on file.
  // Customers who registered a non-MY number before the allowlist existed must
  // keep being able to recover their account.
  it('still sends a password reset to an unserved destination on file', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(GB, 'password-reset'), res);
    expect(sendCount()).toBe(1);
    expect(out.body).toEqual({ ok: true, channel: 'sms' });
  });

  // …but the exemption rides on the account match, not on the purpose string:
  // an unknown number gets the pre-existing silent no-send either way.
  it('does not send a password reset to a number on no account', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(GB, 'password-reset', []), res);
    expect(sendCount()).toBe(0);
    expect(out.body).toEqual({ ok: true, channel: 'sms' });
  });

  // A configuration that refuses EVERY destination (including the default) is
  // the failure mode most likely to be misread as a Twilio outage, so it must
  // name itself in the log rather than just going quiet.
  it('names dead ISO codes in the log when the allowlist resolves to nothing', async () => {
    const prev = process.env.ALLOWED_SMS_COUNTRIES;
    process.env.ALLOWED_SMS_COUNTRIES = 'SG';
    try {
      await startVerification(mkReq(MY), mkRes().res);
      expect(sendCount()).toBe(0); // even the default destination is dead now
      const lines = warn.mock.calls.map((c) => c[0] as string);
      expect(lines.some((l) => l.includes('ALLOWED_SMS_COUNTRIES') && l.includes('SG'))).toBe(
        true,
      );
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_SMS_COUNTRIES;
      else process.env.ALLOWED_SMS_COUNTRIES = prev;
    }
  });

  it('stays quiet about ISO codes when the allowlist is sound', async () => {
    await startVerification(mkReq(GB), mkRes().res);
    const lines = warn.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes('ALLOWED_SMS_COUNTRIES'))).toBe(false);
  });
});

/**
 * The duplicate-phone dead end. An account whose phone matches zero or two-plus
 * rows can never complete phone recovery — the check step refuses a multi-match
 * outright — and until now the route said "we'll text you a code" and recorded
 * nothing, so support had no way to tell that story apart from a lost SMS.
 *
 * The identical 200 is the ANTI-ENUMERATION property and is asserted below in
 * all three branches precisely so nobody "helpfully" differentiates it. The fix
 * is a log line, not a different response.
 */
describe('POST /store/phone-verification/start — duplicate-phone diagnosability', () => {
  const line = () => warn.mock.calls.map((c) => String(c[0])).join('\n');

  it('zero matches: identical 200, no SMS, and a warn carrying the count', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(MY, 'password-reset', []), res);
    expect(sendCount()).toBe(0);
    expect(out.body).toEqual({ ok: true, channel: 'sms' });
    expect(line()).toContain('matched 0 accounts');
  });

  it('two matches: byte-identical response, warn with count 2', async () => {
    const { res, out } = mkRes();
    await startVerification(
      mkReq(MY, 'password-reset', [{ id: 'cus_1' }, { id: 'cus_2' }]),
      res,
    );
    expect(sendCount()).toBe(0);
    // Same object as the zero-match and the success branch — a distinct status,
    // body or message here is a phone-enumeration oracle.
    expect(out.body).toEqual({ ok: true, channel: 'sms' });
    expect(line()).toContain('matched 2 accounts');
  });

  it('exactly one match: SMS sent and NOTHING logged (no happy-path noise)', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(MY, 'password-reset', [{ id: 'cus_1' }]), res);
    expect(sendCount()).toBe(1);
    expect(out.body).toEqual({ ok: true, channel: 'sms' });
    expect(warn).not.toHaveBeenCalled();
  });

  // The PII rule, asserted across EVERY warn call rather than calls[0] — an
  // index-based check silently stops covering a branch as soon as call order
  // shifts. A phone number in a log line is the leak this guards.
  it.each([
    ['zero matches', [] as unknown[]],
    ['two matches', [{ id: 'cus_1' }, { id: 'cus_2' }]],
  ])('never logs the phone number itself (%s)', async (_case, matches) => {
    await startVerification(
      mkReq(MY, 'password-reset', matches),
      mkRes().res,
    );
    expect(warn).toHaveBeenCalled();
    expect(line()).not.toContain(MY);
    // Not even the subscriber part on its own — '+60' as a calling code is
    // fine, the dialable remainder is not.
    expect(line()).not.toContain(MY.slice(3));
  });
});

/**
 * The voice fallback. Twilio's delivery receipt says "Delivered" for every
 * Digi (016) destination while none of them ever verifies (2026-09-07), so
 * the OTP needs a second transport the caller can ask for. The route only
 * validates and forwards the choice — the transport owns the request shape.
 */
describe('POST /store/phone-verification/start — channel', () => {
  const reqWith = (channel: unknown) =>
    ({
      body: { phone: MY, purpose: 'signup', channel },
      scope: {
        resolve: (key: string) =>
          key === 'logger' ? { warn } : { listCustomers: jest.fn(async () => [{ id: 'cus_1' }]) },
      },
    }) as never;

  // Assert on the channel argument ALONE: arg 0 is process.env, and a failing
  // matcher over the whole call would print it.
  const channelArg = () => sendPhoneOtp.mock.calls[0][4] as unknown;

  it('forwards the voice channel to the transport', async () => {
    const { res, out } = mkRes();
    await startVerification(reqWith('call'), res);
    expect(sendCount()).toBe(1);
    expect(channelArg()).toBe('call');
    expect(out.body).toEqual({ ok: true, channel: 'call' });
  });

  it('defaults to sms when the body names no channel', async () => {
    await startVerification(mkReq(MY), mkRes().res);
    expect(channelArg()).toBe('sms');
  });

  it('refuses WhatsApp until sender setup is enabled', async () => {
    await expect(startVerification(reqWith('whatsapp'), mkRes().res)).rejects.toThrow(
      /not configured/i,
    );
    expect(sendCount()).toBe(0);
  });

  it('uses WhatsApp only after the operator enables the configured sender', async () => {
    const previous = process.env.PHONE_OTP_DEFAULT_CHANNEL;
    process.env.PHONE_OTP_DEFAULT_CHANNEL = 'whatsapp';
    try {
      const { res, out } = mkRes();
      await startVerification(mkReq(MY), res);
      expect(channelArg()).toBe('whatsapp');
      expect(out.body).toEqual({ ok: true, channel: 'whatsapp' });
    } finally {
      if (previous === undefined) delete process.env.PHONE_OTP_DEFAULT_CHANNEL;
      else process.env.PHONE_OTP_DEFAULT_CHANNEL = previous;
    }
  });

  it('rejects an unknown channel before sending anything', async () => {
    await expect(startVerification(reqWith('email'), mkRes().res)).rejects.toThrow(
      /invalid channel/i,
    );
    expect(sendCount()).toBe(0);
  });
});

/**
 * The sitewide spend ceiling (consumeOtpSendBudget). Per-phone and per-IP
 * tiers never bounded a pumping run over fresh numbers behind rotating
 * Cloudflare edges; this does, and only where texts cost money.
 */
describe('POST /store/phone-verification/start — sitewide send budget', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    consumeOtpSendBudget.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  });

  it('refuses the send and alerts ops once the budget is spent', async () => {
    process.env.NODE_ENV = 'production';
    consumeOtpSendBudget.mockResolvedValue({ allowed: false, retryAfterMs: 1, sitewide: true });
    const { res, out } = mkRes();
    await startVerification(mkReq(MY), res);
    expect(out.status).toBe(429);
    expect(out.retry).toBe('1');
    expect(sendCount()).toBe(0);
    const logged = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('[ops-alert] phone-otp-budget');
    expect(logged).not.toContain(MY.slice(3));
  });

  it('charges every valid attempt before account-dependent exits', async () => {
    process.env.NODE_ENV = 'production';
    await startVerification(mkReq(GB), mkRes().res); // unserved: no send
    await startVerification(mkReq(MY, 'password-reset', []), mkRes().res); // no account
    expect(consumeOtpSendBudget.mock.calls.length).toBe(2);

    await startVerification(mkReq(MY), mkRes().res);
    expect(consumeOtpSendBudget.mock.calls.length).toBe(3);
    expect(sendCount()).toBe(1);
  });

  it('leaves dev and test alone: the dev code costs nothing', async () => {
    await startVerification(mkReq(MY), mkRes().res);
    expect(consumeOtpSendBudget.mock.calls.length).toBe(0);
    expect(sendCount()).toBe(1);
  });

  it('returns the same cooldown response for known and unknown reset numbers', async () => {
    process.env.NODE_ENV = 'production';
    consumeOtpSendBudget.mockResolvedValue({ allowed: false, retryAfterMs: 60_000 });
    for (const matches of [[], [{ id: 'cus_1' }]]) {
      const { res, out } = mkRes();
      await startVerification(mkReq(MY, 'password-reset', matches), res);
      expect(out.body).toEqual({
        type: 'rate_limit_exceeded', message: 'Too many code requests. Try again in 60s.',
      });
      expect(out.status).toBe(429);
    }
    expect(sendCount()).toBe(0);
    expect(consumeOtpSendBudget).toHaveBeenCalledWith(MY, 'sms');
  });

  it('reset then signup cannot distinguish account existence via cooldown or call quota', async () => {
    const real = jest.requireActual<typeof rateLimit>('../../../../utils/rate-limit');
    const redisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    let now = 1_900_000_000_000;
    consumeOtpSendBudget.mockImplementation(async (phone: string, channel: 'sms' | 'call') => {
      // Real policy/store, local memory only; the route still runs its production gate.
      process.env.NODE_ENV = 'test';
      try { return await real.consumeOtpSendBudget(phone, channel, now); }
      finally { process.env.NODE_ENV = 'production'; }
    });
    process.env.NODE_ENV = 'production';
    try {
      const observed: unknown[] = [];
      for (const [phone, matches] of [
        ['+60177000101', []], ['+60177000102', [{ id: 'cus_1' }]],
      ] as const) {
        const start = async (purpose: string) => {
          const { res, out } = mkRes();
          await startVerification(mkReq(phone, purpose, [...matches], 'call'), res);
          return { status: out.status ?? 200, body: out.body };
        };
        const reset = await start('password-reset');
        const immediateSignup = await start('signup');
        now += 60_000;
        await start('password-reset');
        now += 60_000;
        const thirdCall = await start('signup');
        observed.push([reset.status, immediateSignup.status, thirdCall.status]);
        now += 24 * 60 * 60_000;
      }
      expect(observed).toEqual([[200, 429, 429], [200, 429, 429]]);
    } finally {
      if (redisUrl !== undefined) process.env.REDIS_URL = redisUrl;
    }
  });
});
