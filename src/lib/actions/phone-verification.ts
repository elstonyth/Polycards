'use server';

/**
 * Phone-OTP server actions. Thin proxies onto the backend's
 * /store/phone-verification/* routes — running server-side keeps the
 * publishable-key transport consistent with every other action, and lets
 * changePhone read the httpOnly auth cookie it converts to a Bearer header
 * (getAuthToken, below). The proof token itself round-trips through the
 * browser by design: checkPhoneOtp returns it and changePhone takes it back.
 *
 * It does NOT let the backend see the visitor: `sdk` (src/lib/medusa.ts) is
 * built from a base URL and a publishable key and forwards no client headers,
 * so every OTP request arrives from this server's single egress IP. The
 * backend's IP-keyed OTP limiters are therefore a whole-STOREFRONT circuit
 * breaker, and the PER-PHONE tier is the only real per-client / SMS-cost
 * budget — do not delete it as "redundant with the IP tier". Full topology:
 * the phone-OTP limiter module comment in
 * backend/packages/api/src/api/utils/rate-limit.ts.
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import {
  isServedPhoneCountry,
  normalizePhone,
  UNSERVED_PHONE_COUNTRY_ERROR,
} from '@/lib/profile-validation';
import type { PhoneOtpPurpose } from '@/lib/phone-verification';
import { friendlyError, type ErrorRule } from '@/lib/errors';

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

// 429s carry a useful retry message; keep it, genericize everything else.
const messageOf = (error: unknown, fallback: string): string => {
  const msg = error instanceof Error ? error.message : '';
  return /try again in \d+s/i.test(msg) ? msg : fallback;
};

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
const PHONE_CHANGE_RULES: ErrorRule[] = [
  [
    /enter your current password/i,
    'That password is incorrect. Enter your current password to change your phone number.',
  ],
  [
    /verify your current phone number/i,
    'Verify your current phone number before changing it.',
  ],
];

export async function startPhoneOtp(input: {
  phone: string;
  purpose: PhoneOtpPurpose;
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
  try {
    await sdk.client.fetch('/store/phone-verification/start', {
      method: 'POST',
      body: { phone, purpose: input.purpose },
    });
    return { ok: true };
  } catch (error) {
    logger.error('[phone-otp] start failed:', error);
    return fail(messageOf(error, 'Could not send the code. Please try again.'));
  }
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
    return fail('Enter the code from the SMS.');
  try {
    const { token } = await sdk.client.fetch<{ token: string }>(
      '/store/phone-verification/check',
      {
        method: 'POST',
        body: { phone, purpose: input.purpose, code: input.code },
      },
    );
    return { ok: true, token };
  } catch (error) {
    logger.error('[phone-otp] check failed:', error);
    return fail(messageOf(error, 'Invalid or expired code.'));
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
}): Promise<{ ok: true; phone: string } | Fail> {
  const phone = normalizePhone(input.phone);
  if (!phone)
    return fail('Please enter a valid phone number for the selected country.');
  // Authed route — same cookie→Bearer idiom as setAvatarFrame in
  // src/lib/actions/profile-appearance.ts (a custom Mercur route, so this
  // can't go through sdk.store.customer.update like updateCustomerProfile).
  const authToken = await getAuthToken();
  if (!authToken) return fail('Please log in first.');
  try {
    const { customer } = await sdk.client.fetch<{
      customer: { phone: string };
    }>('/store/phone-verification/change', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      // Omitted rather than sent empty when absent: the backend distinguishes
      // "no password supplied" from "wrong password" only by presence.
      body: {
        phone,
        token: input.token,
        ...(input.password ? { password: input.password } : {}),
        ...(input.oldPhoneToken
          ? { old_phone_token: input.oldPhoneToken }
          : {}),
      },
    });
    return { ok: true, phone: customer.phone };
  } catch (error) {
    logger.error('[phone-otp] change failed:', error);
    // Re-auth refusals win; then the same 429 retry-hint passthrough as
    // startPhoneOtp/checkPhoneOtp — a rate-limited change should say how long
    // to wait, not invite an immediate retry; then the generic copy.
    return fail(
      friendlyError(
        error,
        PHONE_CHANGE_RULES,
        messageOf(
          error,
          'Could not update your phone number. Please try again.',
        ),
      ),
    );
  }
}

export async function resetPasswordByPhone(input: {
  token: string;
}): Promise<{ ok: true; token: string; maskedEmail: string } | Fail> {
  try {
    const data = await sdk.client.fetch<{ token: string; maskedEmail: string }>(
      '/store/phone-verification/password-reset',
      { method: 'POST', body: { token: input.token } },
    );
    return { ok: true, ...data };
  } catch (error) {
    logger.error('[phone-otp] reset exchange failed:', error);
    // Designed-disclosure messages win; a 429's retry text is the next
    // fallback (messageOf), the generic copy is the last resort.
    return fail(
      friendlyError(
        error,
        PHONE_RESET_RULES,
        messageOf(
          error,
          'Could not verify this phone. Reset by email instead.',
        ),
      ),
    );
  }
}
