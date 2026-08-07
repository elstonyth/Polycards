import {
  E164_RE,
  isAllowedSmsDestination,
  isPhoneOtpPurpose,
  isPhoneVerificationRequired,
  isTwilioVerifyConfigured,
  unresolvableSmsCountries,
  signPhoneProof,
  verifyPhoneProof,
  sendPhoneOtp,
  checkPhoneOtpCode,
} from '../phone-verification';

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

// The destination allowlist is the only ceiling on SMS-pumping that survives an
// attacker rotating phone numbers, so its FAIL DIRECTION matters as much as its
// happy path: misconfiguration must never widen it to "everywhere", and must
// never narrow it to "nowhere" (that bricks signup).
describe('sms destination allowlist', () => {
  const GB = '+442079460958';

  it('allows the default set and refuses everything else', () => {
    expect(isAllowedSmsDestination({}, PHONE)).toBe(true);
    expect(isAllowedSmsDestination({}, GB)).toBe(false);
    expect(isAllowedSmsDestination({}, '+15550001111')).toBe(false);
  });

  it('widens per call from env, not at module load', () => {
    expect(isAllowedSmsDestination({ ALLOWED_SMS_COUNTRIES: 'MY,GB' }, GB)).toBe(true);
    // Same module instance, next call, back to refusing — proves the env read
    // happens per call.
    expect(isAllowedSmsDestination({}, GB)).toBe(false);
  });

  it('narrows per call too — MY is not hardcoded as always-on', () => {
    expect(isAllowedSmsDestination({ ALLOWED_SMS_COUNTRIES: 'GB' }, PHONE)).toBe(false);
  });

  it('falls back to the default on an empty or whitespace value, never to allow-all', () => {
    for (const ALLOWED_SMS_COUNTRIES of ['', '   ', ',', ' , , ']) {
      // Fails CLOSED for unserved destinations…
      expect(isAllowedSmsDestination({ ALLOWED_SMS_COUNTRIES }, GB)).toBe(false);
      // …and, just as importantly, still OPEN for the default set: a blank in
      // the DO spec must not brick every Malaysian signup.
      expect(isAllowedSmsDestination({ ALLOWED_SMS_COUNTRIES }, PHONE)).toBe(true);
    }
  });

  it('tolerates mixed case and stray whitespace', () => {
    expect(isAllowedSmsDestination({ ALLOWED_SMS_COUNTRIES: ' my , gb ' }, GB)).toBe(true);
    expect(isAllowedSmsDestination({ ALLOWED_SMS_COUNTRIES: '\tGb\n' }, GB)).toBe(true);
  });

  // The ISO→prefix table is the coarse stand-in for a parser. An unlisted code
  // resolves to no prefix, so naming it widens NOTHING — pinned here so the
  // half-landed widening is a failing test, not a silent production surprise.
  it('ignores an ISO code with no dialling-code row', () => {
    expect(isAllowedSmsDestination({ ALLOWED_SMS_COUNTRIES: 'SG' }, '+6561234567')).toBe(
      false,
    );
    // Worse than "widens nothing": a non-empty value suppresses the default, so
    // this configuration also stops the numbers that USED to work. Every send
    // dies at once, which is why unresolvableSmsCountries exists.
    expect(isAllowedSmsDestination({ ALLOWED_SMS_COUNTRIES: 'SG' }, PHONE)).toBe(false);
  });

  it('reports the ISO codes that resolve to nothing', () => {
    expect(unresolvableSmsCountries({ ALLOWED_SMS_COUNTRIES: ' my , sg , zz ' })).toEqual(
      ['SG', 'ZZ'],
    );
    // Silence when the configuration is sound — including the fallback path,
    // so a blank env never produces a spurious misconfiguration warning.
    expect(unresolvableSmsCountries({ ALLOWED_SMS_COUNTRIES: 'MY,GB' })).toEqual([]);
    expect(unresolvableSmsCountries({ ALLOWED_SMS_COUNTRIES: '   ' })).toEqual([]);
    expect(unresolvableSmsCountries({})).toEqual([]);
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
    await sendPhoneOtp({}, logger, PHONE);
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
    await sendPhoneOtp(env, noopLogger, PHONE);
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
    await expect(sendPhoneOtp({ NODE_ENV: 'production' }, noopLogger, PHONE)).rejects.toThrow(
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
    await expect(sendPhoneOtp(env, logger, PHONE)).rejects.toThrow(
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
    await expect(sendPhoneOtp(env, noopLogger, PHONE)).rejects.toThrow(
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
