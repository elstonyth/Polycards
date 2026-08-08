import {
  E164_RE,
  isPhoneOtpPurpose,
  isPhoneVerificationRequired,
  isTwilioVerifyConfigured,
  signPhoneProof,
  verifyPhoneProof,
  sendPhoneOtp,
  checkPhoneOtpCode,
} from '../phone-verification';
import type { PhoneOtpPurpose } from '../phone-verification';

const SECRET = 'test-secret';
const PHONE = '+60107667787';
const noopLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() } as never;

describe('predicates', () => {
  it('requires the literal string true', () => {
    expect(isPhoneVerificationRequired({ PHONE_VERIFICATION_REQUIRED: 'true' })).toBe(true);
    expect(isPhoneVerificationRequired({ PHONE_VERIFICATION_REQUIRED: '1' })).toBe(false);
    expect(isPhoneVerificationRequired({})).toBe(false);
  });
  it('twilio needs all three vars', () => {
    const full = {
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 't',
      TWILIO_VERIFY_SERVICE_SID: 'VA1',
    };
    expect(isTwilioVerifyConfigured(full)).toBe(true);
    expect(isTwilioVerifyConfigured({ ...full, TWILIO_AUTH_TOKEN: '' })).toBe(false);
  });
  it('E164_RE accepts +60/+44 shapes, rejects garbage', () => {
    expect(E164_RE.test('+60107667787')).toBe(true);
    expect(E164_RE.test('+442079460958')).toBe(true);
    expect(E164_RE.test('0107667787')).toBe(false);
    expect(E164_RE.test('+0123')).toBe(false);
  });
  it('purpose guard', () => {
    expect(isPhoneOtpPurpose('signup')).toBe(true);
    expect(isPhoneOtpPurpose('admin')).toBe(false);
  });
});

describe('proof token', () => {
  it('round-trips phone + purpose', () => {
    const token = signPhoneProof(SECRET, PHONE, 'signup');
    expect(verifyPhoneProof(SECRET, token, 'signup')).toEqual({ phone: PHONE });
  });
  it('rejects wrong purpose', () => {
    const token = signPhoneProof(SECRET, PHONE, 'signup');
    expect(verifyPhoneProof(SECRET, token, 'phone-change')).toBeNull();
  });
  it('rejects wrong secret and tampered payload', () => {
    const token = signPhoneProof(SECRET, PHONE, 'signup');
    expect(verifyPhoneProof('other', token, 'signup')).toBeNull();
    const [payload, sig] = token.split('.');
    const forged =
      Buffer.from(JSON.stringify({ phone: '+15550001111', purpose: 'signup', exp: Date.now() + 60_000 })).toString('base64url') +
      '.' + sig;
    expect(verifyPhoneProof(SECRET, forged, 'signup')).toBeNull();
    expect(verifyPhoneProof(SECRET, payload, 'signup')).toBeNull(); // missing sig segment
  });
  it('rejects an expired token', () => {
    const token = signPhoneProof(SECRET, PHONE, 'signup', 1_000);
    expect(verifyPhoneProof(SECRET, token, 'signup', 1_000 + 11 * 60_000)).toBeNull();
  });
});

describe('dev-code transport (NODE_ENV=test)', () => {
  // jest runs with NODE_ENV=test, so the dev/test branch is the live one here.
  it('send logs instead of calling twilio', async () => {
    const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() } as never;
    await sendPhoneOtp({}, logger, PHONE, 'signup');
    expect((logger as { warn: jest.Mock }).warn).toHaveBeenCalledWith(
      expect.stringContaining(PHONE),
    );
  });
  it('check accepts the dev code, rejects others', async () => {
    await expect(checkPhoneOtpCode({}, noopLogger, PHONE, '000000')).resolves.toBe(true);
    await expect(checkPhoneOtpCode({ PHONE_OTP_DEV_CODE: '424242' }, noopLogger, PHONE, '424242')).resolves.toBe(true);
    await expect(checkPhoneOtpCode({}, noopLogger, PHONE, '111111')).resolves.toBe(false);
  });
});

describe('twilio transport', () => {
  const env = {
    NODE_ENV: 'production',
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 'tok',
    TWILIO_VERIFY_SERVICE_SID: 'VA1',
  };
  afterEach(() => jest.restoreAllMocks());

  it('send posts To/Channel with basic auth', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'pending' }), { status: 201 }));
    await sendPhoneOtp(env, noopLogger, PHONE, 'signup');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://verify.twilio.com/v2/Services/VA1/Verifications');
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + Buffer.from('AC1:tok').toString('base64'),
    );
    expect(String(init?.body)).toContain('Channel=sms');
  });
  it('check maps approved → true, anything else → false', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'approved' }), { status: 200 }));
    await expect(checkPhoneOtpCode(env, noopLogger, PHONE, '123456')).resolves.toBe(true);
    jest.restoreAllMocks();
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'pending' }), { status: 200 }));
    await expect(checkPhoneOtpCode(env, noopLogger, PHONE, '123456')).resolves.toBe(false);
  });
  it('send throws MedusaError when unconfigured in prod', async () => {
    await expect(
      sendPhoneOtp({ NODE_ENV: 'production' }, noopLogger, PHONE, 'signup'),
    ).rejects.toThrow(
      /not configured/i,
    );
  });

  // A refused send must log Twilio's numeric error code, not just the bare
  // status: on 2026-08-07 an unfunded trial account and a geo-permission block
  // were indistinguishable 403s in the app logs. The phone number lives in the
  // same response body (message echoes To=), so it must NOT reach the log.
  it('send logs the twilio error code and never the phone number', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 60410, message: `Blocked for ${PHONE}` }), {
        status: 403,
      }),
    );
    const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() } as never;
    await expect(sendPhoneOtp(env, logger, PHONE, 'signup')).rejects.toThrow(
      /could not send the verification code/i,
    );
    const line = (logger as { warn: jest.Mock }).warn.mock.calls[0][0] as string;
    expect(line).toContain('403');
    expect(line).toContain('60410');
    expect(line).not.toContain(PHONE);
  });

  // An abort (timeout, or any other fetch-level failure) must map to the
  // same retryable message as a bad Twilio response — never escape as a raw
  // AbortError / unhandled rejection.
  it('send maps an aborted fetch to the friendly retryable error', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    await expect(sendPhoneOtp(env, noopLogger, PHONE, 'signup')).rejects.toThrow(
      /could not send the verification code/i,
    );
  });
  it('check maps an aborted fetch to the friendly retryable error', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    await expect(checkPhoneOtpCode(env, noopLogger, PHONE, '123456')).rejects.toThrow(
      /could not verify the code/i,
    );
  });
});

// The OTP text is what the human reads before handing a code over. Twilio
// verifies on (phone, code) alone, so with one shared template a code given up
// under a "verify your number" pretext is exchangeable at /check for a
// 'password-reset' proof — and that route returns a live reset token. Naming
// the flow in the SMS is what lets the person reading it refuse.
describe('per-purpose Verify template', () => {
  const base = {
    NODE_ENV: 'production',
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 'tok',
    TWILIO_VERIFY_SERVICE_SID: 'VA1',
  };
  const env = {
    ...base,
    TWILIO_VERIFY_TEMPLATE_SID_SIGNUP: 'HJsignup',
    TWILIO_VERIFY_TEMPLATE_SID_PHONE_CHANGE: 'HJchange',
    TWILIO_VERIFY_TEMPLATE_SID_PASSWORD_RESET: 'HJreset',
  };
  afterEach(() => jest.restoreAllMocks());

  const sendWith = async (e: Record<string, string>, purpose: PhoneOtpPurpose) => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'pending' }), { status: 201 }));
    await sendPhoneOtp(e, noopLogger, PHONE, purpose);
    return new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
  };

  it('sends a DIFFERENT template for each purpose', async () => {
    expect((await sendWith(env, 'signup')).get('TemplateSid')).toBe('HJsignup');
    jest.restoreAllMocks();
    expect((await sendWith(env, 'phone-change')).get('TemplateSid')).toBe('HJchange');
    jest.restoreAllMocks();
    expect((await sendWith(env, 'password-reset')).get('TemplateSid')).toBe('HJreset');
  });

  it('omits TemplateSid entirely when that purpose has no template configured', async () => {
    // Ships dark: before the operator creates the templates this is byte-for-byte
    // the old request, so deploying the code cannot change what customers receive.
    const body = await sendWith(base, 'password-reset');
    expect(body.has('TemplateSid')).toBe(false);
    expect(body.get('Channel')).toBe('sms');
    expect(body.get('To')).toBe(PHONE);
  });

  it('does not fall back to another purpose template when its own is unset', async () => {
    // The dangerous failure: password-reset silently borrowing the signup text.
    const partial = { ...base, TWILIO_VERIFY_TEMPLATE_SID_SIGNUP: 'HJsignup' };
    expect((await sendWith(partial, 'password-reset')).has('TemplateSid')).toBe(false);
  });

  it('names the purpose in the dev transport log', async () => {
    const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() } as never;
    await sendPhoneOtp({}, logger, PHONE, 'password-reset');
    expect((logger as { warn: jest.Mock }).warn).toHaveBeenCalledWith(
      expect.stringContaining('password-reset'),
    );
  });
});

// createHmac('sha256', '') is legal in Node and returns a MAC anyone can
// recompute, so an empty secret makes every proof forgeable. Unreachable today
// — all four call sites guard first — but the guard stops a fifth caller from
// silently downgrading the scheme.
describe('empty-secret guard', () => {
  it('refuses to sign or verify with an empty secret', () => {
    expect(() => signPhoneProof('', PHONE, 'signup')).toThrow(/not configured/i);
    expect(() => verifyPhoneProof('', 'anything.atall', 'signup')).toThrow(/not configured/i);
  });

  it('still signs and verifies with a real secret', () => {
    const token = signPhoneProof(SECRET, PHONE, 'signup');
    expect(verifyPhoneProof(SECRET, token, 'signup')).toEqual({ phone: PHONE });
  });
});
