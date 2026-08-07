import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same wholesale-mock shape as auth.test.ts: the real data modules import
// 'server-only' and touch next/headers, so only the action logic runs here.
const mocks = vi.hoisted(() => ({
  clientFetch: vi.fn(),
  logError: vi.fn(),
  getAuthToken: vi.fn(),
}));

vi.mock('@/lib/medusa', () => ({
  sdk: { client: { fetch: mocks.clientFetch } },
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@/lib/data/customer', () => ({ getAuthToken: mocks.getAuthToken }));

const { startPhoneOtp, changePhone } =
  await import('@/lib/actions/phone-verification');

const MY = '+60107667787';
const GB = '+442079460958';

beforeEach(() => {
  mocks.clientFetch.mockReset().mockResolvedValue({});
  mocks.getAuthToken.mockReset().mockResolvedValue('tok_customer');
});

describe('startPhoneOtp — served-destination gate', () => {
  it('sends for a served number', async () => {
    await expect(
      startPhoneOtp({ phone: MY, purpose: 'signup' }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(mocks.clientFetch).toHaveBeenCalledTimes(1);
  });

  // The picker only offers MY, but typing a leading `+` overrides it — this is
  // the path that would otherwise reach a backend that refuses in silence.
  it.each(['signup', 'phone-change'] as const)(
    'rejects a typed unserved number for %s, before any request',
    async (purpose) => {
      const result = await startPhoneOtp({ phone: GB, purpose });
      expect(result).toEqual({
        ok: false,
        error:
          'We can only send verification codes to Malaysian (+60) numbers right now.',
      });
      // Never reached the network: no wasted call, and no silent failure.
      expect(mocks.clientFetch).not.toHaveBeenCalled();
    },
  );

  // Exempt for the same reason the backend exempts it — password-reset can only
  // text a number already on an account, and customers whose stored number
  // predates the allowlist must still be able to recover.
  it('lets a password reset through for an unserved number', async () => {
    await expect(
      startPhoneOtp({ phone: GB, purpose: 'password-reset' }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.clientFetch).toHaveBeenCalledTimes(1);
  });

  // The stored-number path SettingsForm's 'old-otp' step depends on: it feeds
  // the customer's own E.164 number back through this action with the
  // 'phone-change' purpose, which is NOT exempt from the guard above. A served
  // number must reach the network — this is what backs "the old-number send is
  // not blocked for a legitimate stored number".
  it('sends an E.164 stored number for phone-change', async () => {
    await expect(
      startPhoneOtp({ phone: MY, purpose: 'phone-change' }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.clientFetch).toHaveBeenCalledTimes(1);
  });

  it('still rejects an unparseable number first', async () => {
    const result = await startPhoneOtp({
      phone: 'nonsense',
      purpose: 'signup',
    });
    expect(result).toEqual({
      ok: false,
      error: 'Please enter a valid phone number for the selected country.',
    });
    expect(mocks.clientFetch).not.toHaveBeenCalled();
  });
});

// The re-auth fields the backend's phone-change gate needs. `password` must
// reach the wire (an omitted one 401s), and it must be OMITTED rather than sent
// empty — the route distinguishes "no password supplied" from "wrong password"
// by presence alone.
describe('changePhone — re-auth fields', () => {
  // `!` because the assertions that follow are exactly what proves a call
  // happened — an undefined here should read as "no request was made".
  const bodyOf = () => mocks.clientFetch.mock.calls[0]![1].body;

  beforeEach(() => {
    mocks.clientFetch.mockResolvedValue({ customer: { phone: MY } });
  });

  it('forwards the current password', async () => {
    await expect(
      changePhone({ phone: MY, token: 'proof', password: 'hunter2' }),
    ).resolves.toEqual({ ok: true, phone: MY });
    expect(bodyOf()).toEqual({
      phone: MY,
      token: 'proof',
      password: 'hunter2',
    });
  });

  it('forwards old_phone_token under its snake_case wire name', async () => {
    await changePhone({ phone: MY, token: 'proof', oldPhoneToken: 'oldproof' });
    expect(bodyOf()).toEqual({
      phone: MY,
      token: 'proof',
      old_phone_token: 'oldproof',
    });
  });

  it('omits both keys when neither is supplied', async () => {
    await changePhone({ phone: MY, token: 'proof' });
    expect(bodyOf()).toEqual({ phone: MY, token: 'proof' });
  });

  it('omits an empty password rather than sending it', async () => {
    await changePhone({ phone: MY, token: 'proof', password: '' });
    expect(bodyOf()).toEqual({ phone: MY, token: 'proof' });
  });

  // The genericizer would otherwise turn this into "Could not update your phone
  // number. Please try again." in front of someone who mistyped their password.
  it('surfaces the backend re-auth refusals instead of the generic copy', async () => {
    mocks.clientFetch.mockRejectedValue(
      new Error('Enter your current password to change your phone number.'),
    );
    const result = await changePhone({
      phone: MY,
      token: 'proof',
      password: 'wrong',
    });
    expect(result).toEqual({
      ok: false,
      error:
        'That password is incorrect. Enter your current password to change your phone number.',
    });

    mocks.clientFetch.mockRejectedValue(
      new Error('Verify your current phone number to change it.'),
    );
    await expect(changePhone({ phone: MY, token: 'proof' })).resolves.toEqual({
      ok: false,
      error: 'Verify your current phone number before changing it.',
      // Set here too — see the dedicated describe below for why the flag
      // exists; this assertion is the exact-object one, so it has to carry it.
      needsOldPhoneProof: true,
    });
  });
});

// SettingsForm branches its whole flow on this: a Google-only account that
// already has a phone gets a SECOND OTP step, for the number it is moving away
// from. The backend is the only thing that knows which cohort the caller is in
// (its rule is "has an emailpass identity", and an account holding both a
// password and a Google login takes the password branch), so the client
// attempts the change and reads the answer off the refusal.
describe('changePhone — needsOldPhoneProof discriminator', () => {
  it('flags the old-phone refusal', async () => {
    mocks.clientFetch.mockRejectedValue(
      new Error('Verify your current phone number to change it.'),
    );
    const result = await changePhone({ phone: MY, token: 'proof' });
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('needsOldPhoneProof', true);
  });

  // Without this the UI would send the user to a second OTP step after a
  // mistyped password, which they can never satisfy.
  it.each([
    [
      'the password refusal',
      'Enter your current password to change your phone number.',
    ],
    ['a rate limit', 'Too many requests. Try again in 30s.'],
    ['an unrecognised failure', 'boom'],
  ])('leaves the flag off for %s', async (_case, message) => {
    mocks.clientFetch.mockRejectedValue(new Error(message));
    const result = await changePhone({ phone: MY, token: 'proof' });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('needsOldPhoneProof');
  });

  it('leaves the flag off on success', async () => {
    mocks.clientFetch.mockResolvedValue({ customer: { phone: MY } });
    const result = await changePhone({ phone: MY, token: 'proof' });
    expect(result).toEqual({ ok: true, phone: MY });
  });
});
