// The signup form's phone-code step, as pure state: no React, no requests —
// see src/lib/__tests__/signup-otp.test.ts. AuthForm keeps the side effects
// (signup(), the SMS send, notes, busy) and asks this module what to do.
//
// The money rule it holds: a proof token bought with a paid SMS stays valid for
// ~10 minutes for the SAME phone. After a signup() that fails once the code has
// passed (e.g. a duplicate email), the next submit for that phone reuses the
// proof instead of sending — and paying for — another SMS. Only a refusal of
// the proof itself drops it and falls through to a fresh code.

export type SignupFields = {
  email: string;
  password: string;
  first_name: string;
  real_name: string;
  referral_code: string;
};

/** The signup form's values with the phone, as signup() takes them. */
export type SignupValues = SignupFields & { phone: string };

/** The signup form's values, taken the moment a code is sent. It SURVIVES
 *  leaving the code step (Back, or a signup() failure after a real SMS) so the
 *  remounted form re-seeds its uncontrolled inputs instead of rendering empty. */
export type SignupDraft = SignupValues & {
  /** A still-valid proof from a signup() that failed after the code passed;
   *  null once the backend refuses it, and before any code was verified. */
  proofToken: string | null;
};

export type SignupOtpState = {
  draft: SignupDraft | null;
  /** On the code step: the draft holds the values signup() will send. */
  enteringCode: boolean;
};

export const SIGNUP_OTP_START: SignupOtpState = {
  draft: null,
  enteringCode: false,
};

type SignupResult = { ok: true } | { ok: false; error: string };

export type SignupOtpEvent =
  /** A code was sent for these values: open the code step. */
  | { type: 'code-sent'; fields: SignupValues }
  /** Back from the code step to the form. */
  | { type: 'back' }
  /** The code passed but signup() failed: keep the proof for the next submit. */
  | { type: 'verified-signup-failed'; token: string }
  /** signup() ran again on the held proof with the newly typed values. */
  | {
      type: 'proof-retried';
      fields: SignupValues;
      result: SignupResult;
    }
  /** Login/signup switched: forget the draft and its proof. */
  | { type: 'reset' };

/**
 * True when signup() refused the PROOF itself (missing, expired or used), so a
 * fresh code must be sent. AuthResult carries no error code, only copy, so this
 * reads the copy: auth.ts keeps "verif" in every proof refusal for this reason
 * (pinned in src/lib/actions/__tests__/auth.test.ts).
 */
export function proofIsDead(result: SignupResult): boolean {
  return !result.ok && /verif/i.test(result.error);
}

/** The proof to reuse for a submit on `phone`, or null to send a fresh code.
 *  A different phone skips the proof but does not clear it: only a sent code
 *  replaces the draft. */
export function heldProof(state: SignupOtpState, phone: string): string | null {
  const { draft } = state;
  return draft?.proofToken && draft.phone === phone ? draft.proofToken : null;
}

export function signupOtpReducer(
  state: SignupOtpState,
  event: SignupOtpEvent,
): SignupOtpState {
  switch (event.type) {
    case 'code-sent':
      return {
        enteringCode: true,
        draft: { ...event.fields, proofToken: null },
      };
    case 'back':
      return { ...state, enteringCode: false };
    case 'verified-signup-failed':
      return {
        enteringCode: false,
        draft: state.draft ? { ...state.draft, proofToken: event.token } : null,
      };
    case 'proof-retried': {
      const { draft } = state;
      if (!draft?.proofToken) return state;
      // A dead proof keeps the draft as it was: the fresh code that follows
      // replaces it, and a failed send leaves the form seeded as before.
      return proofIsDead(event.result)
        ? { ...state, draft: { ...draft, proofToken: null } }
        : {
            ...state,
            draft: { ...event.fields, proofToken: draft.proofToken },
          };
    }
    case 'reset':
      return SIGNUP_OTP_START;
  }
}
