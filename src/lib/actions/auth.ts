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
