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
import { logger } from '@/lib/logger';
import { setAuthToken, clearAuthToken } from '@/lib/data/customer';
import { fetchProfileHandle } from '@/lib/data/profiles';
import { friendlyError, type ErrorRule } from '@/lib/errors';

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
  | { ok: true; customer: AuthCustomer }
  | { ok: false; error: string };

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
  [/already exists/i, 'An account with this email already exists.'],
  [/invalid email or password/i, 'Incorrect email or password.'],
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

export async function signup(input: {
  email: string;
  password: string;
  first_name?: string;
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

  try {
    const registerToken = await exchangeToken(
      '/auth/customer/emailpass/register',
      email,
      input.password,
    );
    await sdk.store.customer.create(
      { email, first_name: input.first_name?.trim() || undefined },
      {},
      { Authorization: `Bearer ${registerToken}` },
    );
    // The register token isn't a session token — log in to get the real one.
    return await login({ email, password: input.password });
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
 * `sdk.client.fetch` with an explicit Bearer, so the shared SDK singleton never
 * holds per-request auth state.
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

export async function googleLoginStart(): Promise<
  { ok: true; location: string } | { ok: false; error: string }
> {
  try {
    const h = await headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (!host) return { ok: false, error: 'Could not determine site origin.' };
    const proto =
      h.get('x-forwarded-proto') ??
      (process.env.NODE_ENV === 'production' ? 'https' : 'http');
    const callback_url = `${proto}://${host}/auth/google/callback`;

    const { location } = await sdk.client.fetch<{ location?: string }>(
      '/auth/customer/google',
      { method: 'POST', body: { callback_url } },
    );
    if (!location)
      return { ok: false, error: 'Google sign-in is currently unavailable.' };
    return { ok: true, location };
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
}): Promise<AuthResult> {
  if (!query.code || !query.state)
    return { ok: false, error: 'Google sign-in was cancelled or failed.' };

  try {
    const { token } = await sdk.client.fetch<TokenResponse>(
      '/auth/customer/google/callback',
      { method: 'GET', query: { code: query.code, state: query.state } },
    );

    const payload = decodeJwtPayload(token);
    let sessionToken = token;
    // Empty actor_id ⇒ first Google login: no customer record yet, create one.
    if (!payload.actor_id) {
      const email = payload.user_metadata?.email;
      if (!email) {
        // Email should ride in the token's user_metadata (the google provider
        // copies it from the verified id_token). If it's absent, log the payload
        // SHAPE (keys only, never values) so the cause is diagnosable — this is
        // the one link in the flow that wasn't verifiable without a real login.
        logger.error('[auth] google token missing user_metadata.email', {
          payloadKeys: Object.keys(payload),
          userMetadataKeys: Object.keys(payload.user_metadata ?? {}),
        });
        return { ok: false, error: 'Google did not share a verified email.' };
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
      const refreshed = await sdk.client.fetch<TokenResponse>(
        '/auth/token/refresh',
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
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
      return { ok: true, customer: toAuthCustomer(customer, handle) };
    } catch (error) {
      await clearAuthToken();
      throw error;
    }
  } catch (error) {
    logger.error('[auth] google callback failed:', error);
    return {
      ok: false,
      error: friendlyError(
        error,
        AUTH_RULES,
        'Could not complete Google sign-in. Please try again.',
      ),
    };
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
