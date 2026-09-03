'use server';

/**
 * Customer auth server actions (emailpass). Called from the client auth modal.
 * Running server-side keeps the JWT in an httpOnly cookie and avoids browser
 * CORS (the backend doesn't allow the :4000 origin). The token exchange uses
 * `sdk.client.fetch` (returns `{ token }`) so the shared SDK singleton never
 * holds per-request auth state; customer create/retrieve pass an explicit Bearer.
 *
 * Medusa v2 emailpass flow (verified against the backend):
 *  signup: register → {token} → create customer (Bearer register-token) → login
 *  login:  /auth/customer/emailpass → {token} → store → retrieve /me
 */
import { headers } from 'next/headers';
import type { HttpTypes } from '@medusajs/types';
import { sdk } from '@/lib/medusa';
import { authedFetch } from '@/lib/authed-fetch';
import { logger } from '@/lib/logger';
import {
  setAuthToken,
  clearAuthToken,
  setOauthState,
} from '@/lib/data/customer';
import { fetchProfileHandle } from '@/lib/data/profiles';
import { friendlyError, type ErrorRule } from '@/lib/errors';
import { bindReferral, setReferralCookie } from '@/lib/referral-cookie';
import { normalizeReferralCode } from '@/lib/referral-code';
import { lookupReferralCode } from '@/lib/data/referral';
import { NAME_MAX, normalizePhone } from '@/lib/profile-validation';
import { resolveCallbackOrigin } from '@/lib/allowed-hosts';
import { PHONE_VERIFICATION_REQUIRED } from '@/lib/phone-verification';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export type AuthCustomer = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  /** Public profile handle (lazily assigned by the backend) — null only if
   * the handle fetch failed; /api/me refreshes it. */
  handle: string | null;
  avatar_url: string | null;
};

export type AuthResult =
  { ok: true; customer: AuthCustomer } | { ok: false; error: string };

/**
 * Why a Google sign-in did not complete — a short CODE, never copy. The
 * callback route forwards it as `?reason=` and /auth/google/failed maps it to
 * text, so no free text ever rides that query string onto a first-party page
 * (`?reason=Your+wallet+is+frozen…` under the Polycards header was a phishing
 * line waiting to happen). Unknown codes fall back to the page's default.
 */
export type GoogleFailReason =
  | 'origin'
  | 'cancelled'
  | 'expired'
  | 'email'
  | 'exists'
  | 'disabled'
  | 'failed';

export type GoogleCallbackResult =
  | { ok: true; customer: AuthCustomer }
  | { ok: false; reason: GoogleFailReason };

type TokenResponse = { token: string };

const toAuthCustomer = (
  c: HttpTypes.StoreCustomer,
  handle: string | null,
): AuthCustomer => ({
  id: c.id,
  email: c.email,
  first_name: c.first_name,
  last_name: c.last_name,
  handle,
  avatar_url:
    typeof (c.metadata ?? {})['avatar_url'] === 'string'
      ? ((c.metadata ?? {})['avatar_url'] as string)
      : null,
});

// Known backend errors → friendly copy (patterns local to auth; never raw).
const AUTH_RULES: ErrorRule[] = [
  // One phone = one account (the signup gate in
  // backend/packages/api/src/api/utils/phone-verification-guard.ts). Normally
  // caught a step earlier at the OTP check, so this fires only when the number
  // was claimed inside the proof's 10-minute window — rare, and the copy has to
  // name the phone or they retry the same number forever. Pattern is kept tight
  // for the reason the disabled-account rule states below; order against the
  // email rule is not load-bearing (neither message matches the other).
  [
    /phone number is already in use/i,
    'This phone number is already registered to another account. Log in instead, or use a different number.',
  ],
  [
    /already exists/i,
    'An account with this email already exists. Sign in with your password instead.',
  ],
  [/invalid email or password/i, 'Incorrect email or password.'],
  // POLYCARD-BACK §4.2 — the backend blocks a disabled account at the emailpass
  // token exchange. Keep the pattern tight (not a bare /disabled/i) so it can't
  // hijack unrelated copy that merely contains the word.
  [
    /account has been disabled/i,
    'This account has been disabled. Please contact support.',
  ],
];

async function exchangeToken(
  path: string,
  email: string,
  password: string,
): Promise<string> {
  const { token } = await sdk.client.fetch<TokenResponse>(path, {
    method: 'POST',
    body: { email, password },
  });
  return token;
}

export async function login(input: {
  email: string;
  password: string;
}): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  // Validate at the boundary — a server action is a public endpoint.
  if (!EMAIL_RE.test(email))
    return { ok: false, error: 'Please enter a valid email address.' };
  if (!input.password)
    return { ok: false, error: 'Please enter your password.' };

  try {
    const token = await exchangeToken(
      '/auth/customer/emailpass',
      email,
      input.password,
    );
    await setAuthToken(token);
    try {
      const { customer } = await sdk.store.customer.retrieve(
        {},
        { Authorization: `Bearer ${token}` },
      );
      // Lazily-assigned public profile handle for the "My Profile" link —
      // explicit token (the cookie was set this same request).
      const handle = await fetchProfileHandle(token);
      return { ok: true, customer: toAuthCustomer(customer, handle) };
    } catch (error) {
      // Don't leave a cookie we couldn't validate.
      await clearAuthToken();
      throw error;
    }
  } catch (error) {
    logger.error('[auth] login failed:', error);
    return {
      ok: false,
      error: friendlyError(
        error,
        AUTH_RULES,
        'Could not log in. Please try again.',
      ),
    };
  }
}

const REFERRAL_SHAPE_ERROR =
  'Referral codes are 8 letters and numbers — check it or leave it blank.';
const REFERRAL_UNKNOWN_ERROR =
  "We couldn't find that referral code. Check it or leave it blank.";

/**
 * Pre-flight for the signup form's optional referral code: shape, then the
 * public existence check, so a typo is caught BEFORE the phone OTP is sent
 * and the account created. `signup()` runs the same check (a server action is
 * a public endpoint). A backend outage is not the user's fault: it passes
 * through and the post-signup bind re-validates.
 */
export async function checkReferralCode(input: {
  code: string;
}): Promise<{ ok: true; code: string | null } | { ok: false; error: string }> {
  // A server action is a public endpoint: the body is typed but not trusted.
  const raw = typeof input?.code === 'string' ? input.code : '';
  if (!raw.trim()) return { ok: true, code: null };
  const code = normalizeReferralCode(raw);
  if (!code) return { ok: false, error: REFERRAL_SHAPE_ERROR };
  const lookup = await lookupReferralCode(code);
  if (lookup.status === 'notfound') {
    return { ok: false, error: REFERRAL_UNKNOWN_ERROR };
  }
  return { ok: true, code };
}

export async function signup(input: {
  email: string;
  password: string;
  first_name?: string;
  phone?: string;
  phone_verification_token?: string;
  /** Optional code typed into the form; the /r/<code> cookie is the fallback. */
  referral_code?: string;
}): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email))
    return { ok: false, error: 'Please enter a valid email address.' };
  // Presence first — a missing/undefined password (API client, autofill glitch)
  // would otherwise throw on `.length` before the try-block (mirrors `login`).
  if (!input.password)
    return { ok: false, error: 'Please enter your password.' };
  if (input.password.length < MIN_PASSWORD_LENGTH)
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  // Phone is REQUIRED at registration (operator requirement) and stored
  // normalized to E.164 (+60…, +44…, …) so it flows into delivery orders
  // reliably.
  const phone = normalizePhone(input.phone ?? '');
  if (!phone)
    return {
      ok: false,
      error: 'Please enter a valid phone number for the selected country.',
    };
  // Reject (not truncate) an over-long name — same rule as updateProfile, so a
  // name accepted at signup can never be refused later on the settings page.
  const first_name = input.first_name?.trim() || undefined;
  if (first_name && first_name.length > NAME_MAX)
    return {
      ok: false,
      error: `Names must be ${NAME_MAX} characters or fewer.`,
    };
  // Enforcement is mirrored client-side for UX only — the backend gate
  // (requireSignupPhoneProof) is authoritative; this just avoids a round trip
  // for the common case where the storefront flag matches the backend's.
  if (PHONE_VERIFICATION_REQUIRED && !input.phone_verification_token)
    return { ok: false, error: 'Please verify your phone number first.' };
  // Optional referral code: reject a bad one BEFORE the account exists, or
  // the typo would silently cost the referrer their recruit.
  const referral = await checkReferralCode({ code: input.referral_code ?? '' });
  if (!referral.ok) return referral;

  try {
    const registerToken = await exchangeToken(
      '/auth/customer/emailpass/register',
      email,
      input.password,
    );
    await sdk.store.customer.create(
      { email, first_name, phone },
      {},
      {
        Authorization: `Bearer ${registerToken}`,
        ...(input.phone_verification_token
          ? { 'x-phone-verification': input.phone_verification_token }
          : {}),
      },
    );
    // The register token isn't a session token — log in to get the real one.
    const result = await login({ email, password: input.password });
    if (result.ok) {
      // One-shot referral attribution: the code from the form, else the
      // /r/<code> cookie. Swallows every failure internally — a referral
      // hiccup must never fail a signup.
      await bindReferral(referral.code);
    }
    return result;
  } catch (error) {
    logger.error('[auth] signup failed:', error);
    return {
      ok: false,
      error: friendlyError(
        error,
        AUTH_RULES,
        'Could not create your account. Please try again.',
      ),
    };
  }
}

/**
 * Google OAuth (customer social login). Two server actions mirror the emailpass
 * flow — token exchange stays server-side (httpOnly cookie, no browser CORS) via
 * `sdk.client.fetch` (and `authedFetch` for the refresh, which carries an
 * explicit Bearer), so the shared SDK singleton never holds per-request auth
 * state.
 *
 * Flow (verified against @medusajs/auth-google 2.13.4):
 *  start:    POST /auth/customer/google { callback_url } → { location } → browser
 *            redirects to Google. `callback_url` is built from THIS request's
 *            origin so one build works local + prod; it must exactly match an
 *            Authorised redirect URI on the OAuth client.
 *  callback: Google → /auth/google/callback?code&state → GET
 *            /auth/customer/google/callback → { token }. Empty `actor_id` in the
 *            token means first login (no customer yet): create the customer (email
 *            comes from the token's user_metadata) then refresh to a real session
 *            token. A returning user's token is already a session token.
 */
type GoogleTokenPayload = {
  actor_id?: string;
  user_metadata?: {
    email?: string;
    given_name?: string;
    family_name?: string;
  };
};

/** Read (not verify) the payload of our own backend-issued JWT. The token is
 * validated by the backend on every subsequent call; here we only need
 * `actor_id` (is a customer attached yet?) and the Google email. */
function decodeJwtPayload(token: string): GoogleTokenPayload {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Malformed auth token.');
  return JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as GoogleTokenPayload;
}

export async function googleLoginStart(input?: {
  /** A code pasted into the signup form before "Continue with Google". It
   *  cannot ride the OAuth round-trip, so it is parked in the referral cookie
   *  and the callback's post-signup bind consumes it exactly like a /r/<code>
   *  landing. Validated first: a typo is refused here, before Google. */
  referral_code?: string;
}): Promise<
  | { ok: true; location: string }
  | { ok: false; error: string; field?: 'referral' }
> {
  const referral = await checkReferralCode({
    code: input?.referral_code ?? '',
  });
  if (!referral.ok) return { ...referral, field: 'referral' };
  try {
    // Harmless if the redirect never happens — the cookie only matters after
    // a Google SIGNUP, and only for 30 days.
    if (referral.code) await setReferralCookie(referral.code);
    const h = await headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    // Host / X-Forwarded-Host / X-Forwarded-Proto are client-supplied. Only
    // build the OAuth callback from a host we actually registered with Google
    // and a scheme clamped to http|https — a spoofed one would be rejected by
    // Google anyway, but validating here keeps attacker-controlled values out
    // of the backend token exchange. Same helper the callback route uses, so
    // the two legs can't resolve the origin differently.
    const origin = resolveCallbackOrigin(host, h.get('x-forwarded-proto'));
    if (!origin)
      return { ok: false, error: 'Could not determine site origin.' };
    const callback_url = `${origin}/auth/google/callback`;

    const { location } = await sdk.client.fetch<{ location?: string }>(
      '/auth/customer/google',
      { method: 'POST', body: { callback_url } },
    );
    if (!location)
      return { ok: false, error: 'Google sign-in is currently unavailable.' };
    // auth-google's getRedirect() sets redirect_uri/client_id/response_type/
    // scope/state and nothing else, so Google silently reuses whichever session
    // is already signed in and never shows the account chooser — a user with
    // two Google accounts can't pick the other one after registering with the
    // first. `prompt=select_account` forces the chooser every time. Added here
    // rather than in the provider: it ships in node_modules and a patch there
    // wouldn't survive a reinstall.
    const url = new URL(location);
    url.searchParams.set('prompt', 'select_account');
    // Bind the provider's `state` to this browser; the callback route refuses
    // a return leg whose state it did not start (login-CSRF — see
    // setOauthState).
    const state = url.searchParams.get('state');
    if (!state)
      return { ok: false, error: 'Google sign-in is currently unavailable.' };
    await setOauthState(state);
    return { ok: true, location: url.toString() };
  } catch (error) {
    logger.error('[auth] google login start failed:', error);
    return {
      ok: false,
      error: 'Could not start Google sign-in. Please try again.',
    };
  }
}

export async function googleCallback(query: {
  code?: string;
  state?: string;
}): Promise<GoogleCallbackResult> {
  if (!query.code || !query.state) return { ok: false, reason: 'cancelled' };

  try {
    const { token } = await sdk.client.fetch<TokenResponse>(
      '/auth/customer/google/callback',
      { method: 'GET', query: { code: query.code, state: query.state } },
    );

    const payload = decodeJwtPayload(token);
    let sessionToken = token;
    // Empty actor_id ⇒ first Google login: no customer record yet, create one.
    if (!payload.actor_id) {
      // Normalize like login()/signup() so a mixed-case Google email can't
      // create a duplicate of, or fail to collide with, an existing account.
      const email = payload.user_metadata?.email?.trim().toLowerCase();
      if (!email) {
        // Email should ride in the token's user_metadata (the google provider
        // copies it from the verified id_token). If it's absent, log the payload
        // SHAPE (keys only, never values) so the cause is diagnosable — this is
        // the one link in the flow that wasn't verifiable without a real login.
        logger.error('[auth] google token missing user_metadata.email', {
          payloadKeys: Object.keys(payload),
          userMetadataKeys: Object.keys(payload.user_metadata ?? {}),
        });
        return { ok: false, reason: 'email' };
      }
      await sdk.store.customer.create(
        {
          email,
          first_name: payload.user_metadata?.given_name,
          last_name: payload.user_metadata?.family_name,
        },
        {},
        { Authorization: `Bearer ${token}` },
      );
      // The post-register token still lacks actor_id — refresh for a real one.
      const refreshed = await authedFetch<TokenResponse>(
        token,
        '/auth/token/refresh',
        { method: 'POST' },
      );
      sessionToken = refreshed.token;
    }

    await setAuthToken(sessionToken);
    try {
      const { customer } = await sdk.store.customer.retrieve(
        {},
        { Authorization: `Bearer ${sessionToken}` },
      );
      const handle = await fetchProfileHandle(sessionToken);
      if (!payload.actor_id) {
        // First Google login IS a signup — consume the invite cookie exactly
        // like the emailpass path, or every Google recruit's link is dropped
        // (review 2026-08-25, spec finding 2). Swallows failures internally.
        await bindReferral();
      }
      return { ok: true, customer: toAuthCustomer(customer, handle) };
    } catch (error) {
      await clearAuthToken();
      throw error;
    }
  } catch (error) {
    logger.error('[auth] google callback failed:', error);
    // Same two backend refusals AUTH_RULES names, as codes (the page owns the
    // copy). Everything else — network, refresh, retrieve — is just 'failed'.
    const text = error instanceof Error ? error.message : String(error);
    const reason: GoogleFailReason = /already exists/i.test(text)
      ? 'exists'
      : /account has been disabled/i.test(text)
        ? 'disabled'
        : 'failed';
    return { ok: false, reason };
  }
}

export async function logout(): Promise<void> {
  await clearAuthToken();
}

/**
 * Requests a password-reset email. The backend 201s for known AND unknown
 * emails (no account enumeration) and emits `auth.password_reset`, whose
 * subscriber delivers the reset link (dev mode: logs it at WARN on the
 * backend console). A failure here is transport/rate-limit only — it says
 * nothing about whether the account exists.
 */
export async function requestPasswordReset(input: {
  email: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email))
    return { ok: false, error: 'Please enter a valid email address.' };

  try {
    await sdk.auth.resetPassword('customer', 'emailpass', {
      identifier: email,
    });
    return { ok: true };
  } catch (error) {
    logger.error('[auth] password reset request failed:', error);
    return {
      ok: false,
      error: 'Could not send the reset email. Please try again.',
    };
  }
}

/**
 * Sets a new password using the single-use token from the reset link
 * (Bearer on /auth/customer/emailpass/update; the backend derives the
 * account from the token, never from the body).
 */
export async function resetPassword(input: {
  token: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.password)
    return { ok: false, error: 'Please enter your password.' };
  if (input.password.length < MIN_PASSWORD_LENGTH)
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  if (!input.token)
    return { ok: false, error: 'This reset link is invalid or has expired.' };

  try {
    await sdk.auth.updateProvider(
      'customer',
      'emailpass',
      { password: input.password },
      input.token,
    );
    return { ok: true };
  } catch (error) {
    logger.error('[auth] password reset failed:', error);
    // Expired, consumed, or tampered token all surface as 401 — one message.
    return {
      ok: false,
      error:
        'This reset link is invalid or has expired. Request a new one and try again.',
    };
  }
}
