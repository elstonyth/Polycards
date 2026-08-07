import {
  E164_RE,
  isAllowedSmsDestination,
  isPhoneOtpPurpose,
  isPhoneVerificationRequired,
  isTwilioVerifyConfigured,
  resolvePhoneGateState,
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

// The boot reporter is the only thing that will ever say out loud which gate
// state a deploy came up in. It must report the fail-open coupling honestly and
// flag a value an operator clearly meant as "on" — without ever echoing a raw
// env value into a deploy log.
describe('resolved gate state (boot reporter)', () => {
  const TWILIO = {
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 't',
    TWILIO_VERIFY_SERVICE_SID: 'VA1',
  };

  it('both gates on, twilio configured — nothing to warn about', () => {
    expect(
      resolvePhoneGateState({
        PHONE_VERIFICATION_REQUIRED: 'true',
        PHONE_GATE_REQUIRED: 'true',
        ...TWILIO,
      }),
    ).toEqual({
      phoneVerificationRequired: true,
      phoneGateRequired: true,
      twilioConfigured: true,
      warnings: [],
    });
  });

  // The fail-open coupling, asserted for the first time: an unset write flag
  // takes the MONEY gate down with it. That is the recorded design (CONTEXT.md
  // rollback lever) — pinned here so it can only ever change deliberately.
  it('unset PHONE_VERIFICATION_REQUIRED drops the money gate with it', () => {
    const state = resolvePhoneGateState({});
    expect(state.phoneVerificationRequired).toBe(false);
    expect(state.phoneGateRequired).toBe(false);
    expect(state.twilioConfigured).toBe(false);
    expect(state.warnings).toEqual([]); // unset is not a typo
  });

  // The documented in-a-hurry lever: money off, writes still gated. An explicit
  // 'false' is a deliberate act, so it must NOT be reported as a mistake.
  it('PHONE_GATE_REQUIRED=false is the money-only rollback, not a warning', () => {
    const state = resolvePhoneGateState({
      PHONE_VERIFICATION_REQUIRED: 'true',
      PHONE_GATE_REQUIRED: 'false',
    });
    expect(state.phoneVerificationRequired).toBe(true);
    expect(state.phoneGateRequired).toBe(false);
    expect(state.warnings).toEqual([]);
  });

  it('an explicit false on the write gate warns about nothing either', () => {
    const state = resolvePhoneGateState({ PHONE_VERIFICATION_REQUIRED: 'false' });
    expect(state.phoneVerificationRequired).toBe(false);
    expect(state.warnings).toEqual([]);
  });

  // The whole reason this reporter exists: the parse is strict `=== 'true'`, so
  // an operator who typed 'True' (or '1', or 'yes') silently disarmed every
  // gate. Do not fix by loosening the parse — the strictness is pinned above.
  it.each(['True', '1', 'yes', 'TRUE'])(
    'flags PHONE_VERIFICATION_REQUIRED=%s as read-as-false',
    (raw) => {
      const state = resolvePhoneGateState({ PHONE_VERIFICATION_REQUIRED: raw });
      expect(state.phoneVerificationRequired).toBe(false);
      expect(state.phoneGateRequired).toBe(false);
      expect(state.warnings).toHaveLength(1);
      expect(state.warnings[0]).toContain('PHONE_VERIFICATION_REQUIRED');
      expect(state.warnings[0]).toContain('read as false');
      // The raw value must never reach a log line: these two are boolean-shaped
      // today, but the habit of echoing env values is how credentials land in a
      // public deploy log.
      expect(state.warnings[0]).not.toContain(raw);
    },
  );

  it('flags a bad PHONE_GATE_REQUIRED independently of the write gate', () => {
    const state = resolvePhoneGateState({
      PHONE_VERIFICATION_REQUIRED: 'true',
      PHONE_GATE_REQUIRED: 'yes',
    });
    expect(state.phoneVerificationRequired).toBe(true);
    expect(state.phoneGateRequired).toBe(false);
    expect(state.warnings).toEqual([
      expect.stringContaining('PHONE_GATE_REQUIRED'),
    ]);
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
    // …and an all-unknown value is still not "allow nothing at all" by accident:
    // it resolves to a non-empty list that simply matches no number.
    expect(isAllowedSmsDestination({ ALLOWED_SMS_COUNTRIES: 'SG' }, PHONE)).toBe(false);
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
