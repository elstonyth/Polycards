'use server';

/**
 * Phone-OTP server actions. Thin proxies onto the backend's
 * /store/phone-verification/* routes — running server-side keeps the
 * publishable-key transport consistent with every other action, and lets
 * changePhone send the httpOnly auth cookie as a Bearer. The proof token
 * itself round-trips through the browser by design: checkPhoneOtp returns it
 * and changePhone takes it back.
 *
 * All four calls go through the `Store` port (src/lib/store.ts). Three carry
 * `auth: 'none'` — they are the pre-login routes, and reading the cookie jar
 * for them would be both pointless and a reason for the route to go dynamic.
 * Only `changePhone` is authenticated. Every response reads through
 * `UncheckedSchema`: these bodies were never validated, and giving the port a
 * schema now would turn a drifted field into an `invalid_shape` failure whose
 * copy ("Invalid or expired code.") would send the caller round a resend loop.
 *
 * It does NOT let the backend see the visitor: the port's transport
 * (src/lib/medusa.ts's `sdk`) is built from a base URL and a publishable key
 * and forwards no client headers, so every OTP request arrives from this
 * server's single egress IP. The
 * backend's IP-keyed OTP limiters are therefore a whole-STOREFRONT circuit
 * breaker, and the PER-PHONE tier is the only real per-client / SMS-cost
 * budget — do not delete it as "redundant with the IP tier". Full topology:
 * the phone-OTP limiter module comment in
 * backend/packages/api/src/api/utils/rate-limit.ts.
 */
import { store, type Failure } from '@/lib/store';
import { logger } from '@/lib/logger';
import { UncheckedSchema } from '@/lib/data/schemas';
import {
  isServedPhoneCountry,
  normalizePhone,
  UNSERVED_PHONE_COUNTRY_ERROR,
} from '@/lib/profile-validation';
import type {
  PhoneOtpChannel,
  PhoneOtpPurpose,
} from '@/lib/phone-verification';
import { friendlyError, type ErrorRule } from '@/lib/errors';

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

// 429s carry a useful retry message; keep it, genericize everything else.
const messageOf = (text: string, fallback: string): string =>
  /try again in \d+s/i.test(text) ? text : fallback;

/** No cookie at all — the call never left (`status` is undefined), so there is
 *  no backend text to read, and the answer is the login prompt rather than
 *  anything `messageOf` would generalize. Only `changePhone` is authenticated;
 *  the other three routes run with `auth: 'none'` and never see this. */
const loggedOut = (f: Failure): boolean =>
  f.kind === 'unauthenticated' && f.status === undefined;

// The three post-OTP outcomes password-reset/route.ts is DESIGNED to
// disclose to a proven phone-holder (Task 5 comment) — a raw FetchError's
// `.message` is the backend MedusaError's literal text, unwrapped (verified
// against node_modules/@medusajs/js-sdk's FetchError: `super(jsonError.message
// ?? resp.statusText)`; same mechanism AUTH_RULES already relies on in
// src/lib/actions/auth.ts). Collapsing these into the generic fallback would
// tell a Google-only account "Reset by email instead." — a dead end, since
// that account has no emailpass identity to reset.
const PHONE_RESET_RULES: ErrorRule[] = [
  [/no account uses this phone number/i, 'No account uses this phone number.'],
  [
    /more than one account uses this phone number/i,
    'More than one account uses this phone number. Reset by email instead.',
  ],
  [/this account signs in with google/i, 'This account signs in with Google.'],
];

// The change route's two re-auth refusals. These MUST survive `messageOf`'s
// genericizer: "Could not update your phone number. Please try again." in front
// of someone who mistyped their password is a dead end — they retry the same
// password forever. Both strings are the route's own MedusaError text
// (backend/packages/api/src/api/store/phone-verification/change/route.ts), read
// off FetchError.message by the same mechanism PHONE_RESET_RULES relies on.
// The Google-only branch's refusal, kept as a named constant because it is
// CONTROL FLOW as well as copy: SettingsForm turns it into a second OTP step
// for the current number. One regex, used both to pick the message below and to
// set `needsOldPhoneProof`, so a reworded rule can never leave the two
// disagreeing.
const NEEDS_OLD_PHONE_PROOF = /verify your current phone number/i;

// One phone = one account (backend/packages/api/src/api/utils/phone-claim.ts).
// Refused at the check step for 'signup', so it arrives here as a FetchError on
// a request whose code was correct — read off `.message` by the same mechanism
// PHONE_RESET_RULES relies on.
const PHONE_CHECK_RULES: ErrorRule[] = [
  [
    /phone number is already in use/i,
    'This phone number is already registered to another account. Log in instead, or use a different number.',
  ],
];

const PHONE_CHANGE_RULES: ErrorRule[] = [
  // Same refusal as PHONE_CHECK_RULES, from the change route's own gate — the
  // caller's OTP was fine, the number just belongs to someone else.
  [
    /phone number is already in use/i,
    'This phone number is already registered to another account.',
  ],
  [
    /enter your current password/i,
    'That password is incorrect. Enter your current password to change your phone number.',
  ],
  [
    NEEDS_OLD_PHONE_PROOF,
    'Verify your current phone number before changing it.',
  ],
  // Expiry, not a mistake the user made. A proof is good for 10 minutes
  // (PROOF_TTL_MS, backend/packages/api/src/utils/phone-verification.ts —
  // fixed, no env knob), and the Google-only flow spends that budget twice:
  // SettingsForm submits the change, is refused for the OLD number, then runs a
  // whole second SMS round-trip while still replaying the NEW number's original
  // proof. Carrier delay plus reading a code out of a notification can outlive
  // the first token, and the generic "Could not update your phone number.
  // Please try again." sends them back round the same loop with the same dead
  // token — the retry can never succeed. Name the expiry so "start again"
  // reads as the fix rather than the thing that just failed.
  [
    /phone verification required/i,
    'That verification expired. Request a new code and enter it within 10 minutes.',
  ],
];

export async function startPhoneOtp(input: {
  phone: string;
  purpose: PhoneOtpPurpose;
  /** Omitted = backend default (sms). Sent only when the user asked for it. */
  channel?: PhoneOtpChannel;
}): Promise<{ ok: true } | Fail> {
  const phone = normalizePhone(input.phone);
  if (!phone)
    return fail('Please enter a valid phone number for the selected country.');
  // The one choke point every OTP send passes through, so the check lives here
  // rather than in AuthForm and SettingsForm separately. Mirrors the backend's
  // isAllowedSmsDestination — including its password-reset exemption, which
  // can only text a number already on an account and must keep working for
  // customers whose stored number predates the allowlist. Without this the
  // backend refuses silently and the user just never gets a code.
  if (input.purpose !== 'password-reset' && !isServedPhoneCountry(phone))
    return fail(UNSERVED_PHONE_COUNTRY_ERROR);
  const r = await store.post(
    '/store/phone-verification/start',
    UncheckedSchema,
    {
      phone,
      purpose: input.purpose,
      ...(input.channel ? { channel: input.channel } : {}),
    },
    { auth: 'none' },
  );
  if (!r.ok) {
    return fail(
      messageOf(r.text, 'Could not send the code. Please try again.'),
    );
  }
  return { ok: true };
}

export async function checkPhoneOtp(input: {
  phone: string;
  purpose: PhoneOtpPurpose;
  code: string;
}): Promise<{ ok: true; token: string } | Fail> {
  const phone = normalizePhone(input.phone);
  if (!phone)
    return fail('Please enter a valid phone number for the selected country.');
  if (!/^\d{4,10}$/.test(input.code))
    return fail('Enter the verification code.');
  const r = await store.post(
    '/store/phone-verification/check',
    UncheckedSchema,
    { phone, purpose: input.purpose, code: input.code },
    { auth: 'none' },
  );
  if (!r.ok) {
    // The duplicate-phone refusal MUST survive the genericizer: the code they
    // typed was correct, and "Invalid or expired code." sends them round the
    // resend loop forever over a problem no code can fix.
    return fail(
      friendlyError(
        r.text,
        PHONE_CHECK_RULES,
        messageOf(r.text, 'Invalid or expired code.'),
      ),
    );
  }
  // JSON parsing accepts null and malformed nested objects; preserve the
  // pre-port projection fallback without changing the Store contract.
  try {
    const { token } = r.data as { token: string };
    return { ok: true, token };
  } catch (error) {
    logger.error('[phone-verification] response projection failed:', error);
    return fail('Invalid or expired code.');
  }
}

// The backend refuses to MOVE a phone on a session alone — a stolen session
// could otherwise take the recovery number and convert itself into a permanent
// takeover through /store/phone-verification/password-reset. It wants the
// account's current password (emailpass accounts) or an OTP proof for the
// number being moved away from (Google-only accounts). Both fields are optional
// here because the one path that needs neither is still live: a Google account
// adding its FIRST phone.
export async function changePhone(input: {
  phone: string;
  token: string;
  password?: string;
  oldPhoneToken?: string;
}): Promise<
  | { ok: true; phone: string }
  // `needsOldPhoneProof` says the account has no emailpass identity and already
  // has a phone, so the backend wants an OTP proof for the CURRENT number. The
  // caller cannot work that out for itself: the backend's rule is "has an
  // emailpass identity", and an account holding BOTH a password and a Google
  // login takes the password branch — any client-side "is this Google-only?"
  // guess would have to reproduce that precedence and would drift from it. The
  // route's own refusal cannot.
  | (Fail & { needsOldPhoneProof?: true })
> {
  const phone = normalizePhone(input.phone);
  if (!phone)
    return fail('Please enter a valid phone number for the selected country.');
  // The one AUTHENTICATED route here — a custom Mercur route, so it cannot go
  // through sdk.store.customer.update like updateCustomerProfile does.
  const r = await store.post(
    '/store/phone-verification/change',
    UncheckedSchema,
    // Omitted rather than sent empty when absent: the backend distinguishes
    // "no password supplied" from "wrong password" only by presence.
    {
      phone,
      token: input.token,
      ...(input.password ? { password: input.password } : {}),
      ...(input.oldPhoneToken ? { old_phone_token: input.oldPhoneToken } : {}),
    },
  );
  if (!r.ok) {
    if (loggedOut(r)) return fail('Please log in first.');
    // Re-auth refusals win; then the same 429 retry-hint passthrough as
    // startPhoneOtp/checkPhoneOtp — a rate-limited change should say how long
    // to wait, not invite an immediate retry; then the generic copy.
    const message = friendlyError(
      r.text,
      PHONE_CHANGE_RULES,
      messageOf(
        r.text,
        'Could not update your phone number. Please try again.',
      ),
    );
    return NEEDS_OLD_PHONE_PROOF.test(r.text)
      ? { ok: false, error: message, needsOldPhoneProof: true }
      : fail(message);
  }
  // JSON parsing accepts null and malformed nested objects; preserve the
  // pre-port projection fallback without changing the Store contract.
  try {
    const { customer } = r.data as { customer: { phone: string } };
    return { ok: true, phone: customer.phone };
  } catch (error) {
    logger.error('[phone-verification] response projection failed:', error);
    return fail('Could not update your phone number. Please try again.');
  }
}

export async function resetPasswordByPhone(input: {
  token: string;
}): Promise<{ ok: true; token: string; maskedEmail: string } | Fail> {
  const r = await store.post(
    '/store/phone-verification/password-reset',
    UncheckedSchema,
    { token: input.token },
    { auth: 'none' },
  );
  if (!r.ok) {
    // Designed-disclosure messages win; a 429's retry text is the next
    // fallback (messageOf), the generic copy is the last resort.
    return fail(
      friendlyError(
        r.text,
        PHONE_RESET_RULES,
        messageOf(
          r.text,
          'Could not verify this phone. Reset by email instead.',
        ),
      ),
    );
  }
  return { ok: true, ...(r.data as { token: string; maskedEmail: string }) };
}
