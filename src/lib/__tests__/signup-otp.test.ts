import { describe, expect, test } from 'vitest';
import {
  SIGNUP_OTP_START,
  heldProof,
  proofIsDead,
  signupOtpReducer,
  type SignupOtpState,
} from '@/lib/signup-otp';

const fields = (over: Partial<Record<string, string>> = {}) => ({
  email: 'a@polycards.app',
  password: 'pw-123456',
  first_name: 'Ash',
  real_name: 'Tan Ah Kow',
  referral_code: '',
  phone: '+60107667787',
  ...over,
});

// The state after a code was sent, then the verified signup() failed (e.g. a
// duplicate email): back on the form, holding a still-valid proof.
const holding = (): SignupOtpState =>
  signupOtpReducer(
    signupOtpReducer(SIGNUP_OTP_START, { type: 'code-sent', fields: fields() }),
    { type: 'verified-signup-failed', token: 'proof-1' },
  );

describe('proofIsDead', () => {
  test('a verification-shaped refusal kills the proof', () => {
    expect(
      proofIsDead({
        ok: false,
        error:
          'Your phone verification expired. Please verify your number again.',
      }),
    ).toBe(true);
    expect(
      proofIsDead({
        ok: false,
        error: 'Please verify your phone number first.',
      }),
    ).toBe(true);
  });

  test('success or any other refusal keeps it', () => {
    expect(proofIsDead({ ok: true })).toBe(false);
    expect(
      proofIsDead({
        ok: false,
        error: 'An account with this email already exists.',
      }),
    ).toBe(false);
  });
});

describe('signupOtpReducer', () => {
  test('a sent code opens the code step with the typed values and no proof', () => {
    const s = signupOtpReducer(SIGNUP_OTP_START, {
      type: 'code-sent',
      fields: fields(),
    });
    expect(s).toEqual({
      enteringCode: true,
      draft: { ...fields(), proofToken: null },
    });
  });

  test('Back leaves the code step and keeps the draft for the form', () => {
    const sent = signupOtpReducer(SIGNUP_OTP_START, {
      type: 'code-sent',
      fields: fields(),
    });
    const s = signupOtpReducer(sent, { type: 'back' });
    expect(s).toEqual({ enteringCode: false, draft: sent.draft });
  });

  test('a failed signup after the code keeps its proof on the draft', () => {
    expect(holding()).toEqual({
      enteringCode: false,
      draft: { ...fields(), proofToken: 'proof-1' },
    });
  });

  test('a failed signup with no draft changes nothing', () => {
    expect(
      signupOtpReducer(SIGNUP_OTP_START, {
        type: 'verified-signup-failed',
        token: 'proof-1',
      }),
    ).toEqual(SIGNUP_OTP_START);
  });

  test('a live proof stays for another retry, with the newly typed values', () => {
    const typed = fields({ email: 'b@polycards.app' });
    const s = signupOtpReducer(holding(), {
      type: 'proof-retried',
      fields: typed,
      result: {
        ok: false,
        error: 'An account with this email already exists.',
      },
    });
    expect(s.draft).toEqual({ ...typed, proofToken: 'proof-1' });
    expect(s.enteringCode).toBe(false);
  });

  test('a dead proof is dropped and the OLD draft values are kept', () => {
    const s = signupOtpReducer(holding(), {
      type: 'proof-retried',
      fields: fields({ email: 'b@polycards.app' }),
      result: {
        ok: false,
        error:
          'Your phone verification expired. Please verify your number again.',
      },
    });
    expect(s.draft).toEqual({ ...fields(), proofToken: null });
  });

  test('a retry without a held proof changes nothing', () => {
    const sent = signupOtpReducer(SIGNUP_OTP_START, {
      type: 'code-sent',
      fields: fields(),
    });
    const s = signupOtpReducer(sent, {
      type: 'proof-retried',
      fields: fields(),
      result: { ok: true },
    });
    expect(s).toBe(sent);
  });

  test('a fresh code replaces the draft and drops any proof', () => {
    const typed = fields({ phone: '+60123456789' });
    const s = signupOtpReducer(holding(), { type: 'code-sent', fields: typed });
    expect(s).toEqual({
      enteringCode: true,
      draft: { ...typed, proofToken: null },
    });
  });

  test('reset clears everything', () => {
    expect(signupOtpReducer(holding(), { type: 'reset' })).toEqual(
      SIGNUP_OTP_START,
    );
  });
});

describe('heldProof', () => {
  test('reuses the proof for the same phone', () => {
    expect(heldProof(holding(), '+60107667787')).toBe('proof-1');
  });

  test('a different phone gets a fresh code, and the old proof stays held', () => {
    const s = holding();
    expect(heldProof(s, '+60123456789')).toBeNull();
    expect(s.draft?.proofToken).toBe('proof-1');
  });

  test('no draft or no proof means a fresh code', () => {
    expect(heldProof(SIGNUP_OTP_START, '+60107667787')).toBeNull();
    const sent = signupOtpReducer(SIGNUP_OTP_START, {
      type: 'code-sent',
      fields: fields(),
    });
    expect(heldProof(sent, '+60107667787')).toBeNull();
  });
});
