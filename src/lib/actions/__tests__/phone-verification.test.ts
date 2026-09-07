import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';
import type { MemoryRoutes } from '@/lib/store-memory';

// The actions import the port's HTTP adapter; point that import at an
// in-memory backend per test (src/lib/__tests__/store-shim.ts). Nothing
// beneath the port (SDK, cookies, logger) is mocked.
vi.mock('@/lib/store', () => ({ store: storeShim }));

const { startPhoneOtp, checkPhoneOtp, changePhone, resetPasswordByPhone } =
  await import('@/lib/actions/phone-verification');

const MY = '+60107667787';
const GB = '+442079460958';

const START = 'POST /store/phone-verification/start';
const CHECK = 'POST /store/phone-verification/check';
const CHANGE = 'POST /store/phone-verification/change';

/** The three routes answering 200 with a body each action can read. */
const OK: MemoryRoutes = {
  [START]: { body: {} },
  [CHECK]: { body: { token: 'proof' } },
  [CHANGE]: { body: { customer: { phone: MY } } },
};

/** One route refusing with `message` — how every backend refusal below
 *  arrives, and what the copy tables match on. */
const refuses = (route: string, message: string) =>
  backend({ ...OK, [route]: { status: 400, body: { message } } });

let mem = backend(OK);
beforeEach(() => {
  mem = backend(OK);
});

describe('startPhoneOtp — served-destination gate', () => {
  it('sends for a served number', async () => {
    await expect(
      startPhoneOtp({ phone: MY, purpose: 'signup' }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(mem.requests).toHaveLength(1);
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
      expect(mem.requests).toEqual([]);
    },
  );

  // Exempt for the same reason the backend exempts it — password-reset can only
  // text a number already on an account, and customers whose stored number
  // predates the allowlist must still be able to recover.
  it('lets a password reset through for an unserved number', async () => {
    await expect(
      startPhoneOtp({ phone: GB, purpose: 'password-reset' }),
    ).resolves.toEqual({ ok: true });
    expect(mem.requests).toHaveLength(1);
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
    expect(mem.requests).toHaveLength(1);
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
    expect(mem.requests).toEqual([]);
  });
});

// The re-auth fields the backend's phone-change gate needs. `password` must
// reach the wire (an omitted one 401s), and it must be OMITTED rather than sent
// empty — the route distinguishes "no password supplied" from "wrong password"
// by presence alone.
describe('changePhone — re-auth fields', () => {
  // `!` because the assertions that follow are exactly what proves a call
  // happened — an undefined here should read as "no request was made".
  const bodyOf = () => mem.requests[0]!.body;

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
    refuses(CHANGE, 'Enter your current password to change your phone number.');
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

    refuses(CHANGE, 'Verify your current phone number to change it.');
    await expect(changePhone({ phone: MY, token: 'proof' })).resolves.toEqual({
      ok: false,
      error: 'Verify your current phone number before changing it.',
      // Set here too — see the dedicated describe below for why the flag
      // exists; this assertion is the exact-object one, so it has to carry it.
      needsOldPhoneProof: true,
    });
  });

  // Same genericizer problem, different cause: the OTP was fine, the number
  // just belongs to someone else. "Please try again." would loop them.
  it('surfaces the duplicate-number refusal', async () => {
    refuses(CHANGE, 'This phone number is already in use.');
    await expect(changePhone({ phone: MY, token: 'proof' })).resolves.toEqual({
      ok: false,
      error: 'This phone number is already registered to another account.',
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
    refuses(CHANGE, 'Verify your current phone number to change it.');
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
    refuses(CHANGE, message);
    const result = await changePhone({ phone: MY, token: 'proof' });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('needsOldPhoneProof');
  });

  it('leaves the flag off on success', async () => {
    const result = await changePhone({ phone: MY, token: 'proof' });
    expect(result).toEqual({ ok: true, phone: MY });
  });
});

// One phone = one account (backend/packages/api/src/api/utils/phone-claim.ts).
// The refusal arrives on a request whose CODE was correct, so `messageOf`'s
// genericizer would tell the user "Invalid or expired code." and send them back
// round the resend loop over a problem no code can fix.
describe('checkPhoneOtp — duplicate-number refusal', () => {
  it('surfaces the refusal instead of the generic code copy', async () => {
    refuses(CHECK, 'This phone number is already in use.');
    await expect(
      checkPhoneOtp({ phone: MY, purpose: 'signup', code: '123456' }),
    ).resolves.toEqual({
      ok: false,
      error:
        'This phone number is already registered to another account. Log in instead, or use a different number.',
    });
  });

  it('still generalizes an unrecognised failure', async () => {
    refuses(CHECK, 'boom');
    await expect(
      checkPhoneOtp({ phone: MY, purpose: 'signup', code: '123456' }),
    ).resolves.toEqual({ ok: false, error: 'Invalid or expired code.' });
  });

  it('returns the proof token on success', async () => {
    await expect(
      checkPhoneOtp({ phone: MY, purpose: 'signup', code: '123456' }),
    ).resolves.toEqual({ ok: true, token: 'proof' });
  });
});

// The three pre-login routes carry `auth: 'none'` — no cookie is read, so no
// Authorization header rides along and the routes stay reachable for a visitor
// who has no session yet. Only the change route is authenticated.
describe('auth mode per route', () => {
  it('sends no bearer on start/check and one on change', async () => {
    await startPhoneOtp({ phone: MY, purpose: 'signup' });
    await checkPhoneOtp({ phone: MY, purpose: 'signup', code: '123456' });
    await changePhone({ phone: MY, token: 'proof' });
    expect(mem.requests.map((r) => [r.path, r.headers])).toEqual([
      ['/store/phone-verification/start', {}],
      ['/store/phone-verification/check', {}],
      [
        '/store/phone-verification/change',
        { Authorization: 'Bearer test-token' },
      ],
    ]);
  });

  it('still reaches the pre-login routes with no session at all', async () => {
    const guest = backend(OK, { token: null });
    await expect(
      startPhoneOtp({ phone: MY, purpose: 'password-reset' }),
    ).resolves.toEqual({ ok: true });
    expect(guest.requests).toHaveLength(1);
  });

  it('changePhone asks for a login when there is no session', async () => {
    const guest = backend(OK, { token: null });
    await expect(changePhone({ phone: MY, token: 'proof' })).resolves.toEqual({
      ok: false,
      error: 'Please log in first.',
    });
    expect(guest.requests).toEqual([]);
  });
});

describe('unchecked phone JSON projection parity', () => {
  it('contains a null OTP check response', async () => {
    backend({ [CHECK]: { body: null } });
    await expect(
      checkPhoneOtp({ phone: MY, purpose: 'signup', code: '123456' }),
    ).resolves.toEqual({ ok: false, error: 'Invalid or expired code.' });
  });
  it('contains a null customer after phone change', async () => {
    backend({ [CHANGE]: { body: { customer: null } } });
    await expect(changePhone({ phone: MY, token: 'proof' })).resolves.toEqual({
      ok: false,
      error: 'Could not update your phone number. Please try again.',
    });
  });
});

describe('resetPasswordByPhone migration seam', () => {
  const route = 'POST /store/phone-verification/password-reset';
  it('posts the proof without cookie auth and returns the reset token and masked email', async () => {
    const mem = backend(
      {
        [route]: {
          body: { token: 'reset-token', maskedEmail: 'w***@example.com' },
        },
      },
      { token: null },
    );
    await expect(
      resetPasswordByPhone({ token: 'phone-proof' }),
    ).resolves.toEqual({
      ok: true,
      token: 'reset-token',
      maskedEmail: 'w***@example.com',
    });
    expect(mem.requests).toEqual([
      {
        method: 'POST',
        path: '/store/phone-verification/password-reset',
        body: { token: 'phone-proof' },
        headers: {},
        cache: 'no-store',
      },
    ]);
  });
  it('preserves the Google-only refusal rather than inviting a dead-end email reset', async () => {
    backend(
      {
        [route]: {
          status: 400,
          body: { message: 'This account signs in with Google.' },
        },
      },
      { token: null },
    );
    await expect(
      resetPasswordByPhone({ token: 'phone-proof' }),
    ).resolves.toEqual({
      ok: false,
      error: 'This account signs in with Google.',
    });
  });
});

// Voice fallback for destinations whose SMS is "Delivered" but never read
// (Digi/016, 2026-09-07). The action forwards the choice verbatim; absent, it
// sends no field at all so the backend's default (sms) stays the single source.
describe('startPhoneOtp — channel', () => {
  const bodyOf = () => mem.requests[0]!.body;

  it('passes the voice channel through to the backend', async () => {
    await expect(
      startPhoneOtp({ phone: MY, purpose: 'phone-change', channel: 'call' }),
    ).resolves.toEqual({ ok: true });
    expect(mem.requests).toHaveLength(1);
    expect(bodyOf()).toEqual({
      phone: MY,
      purpose: 'phone-change',
      channel: 'call',
    });
  });

  it('sends no channel field when none is chosen', async () => {
    await startPhoneOtp({ phone: MY, purpose: 'signup' });
    expect(bodyOf()).toEqual({ phone: MY, purpose: 'signup' });
  });
});
