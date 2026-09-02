/**
 * Server-side customer/session helpers.
 *
 * The customer JWT lives in an httpOnly cookie (not localStorage — XSS-safe per
 * the security rules) and is read only on the server. All Store-API auth calls
 * run server-side (server actions / route handlers / server components), which
 * also sidesteps browser CORS — the backend's AUTH/STORE CORS doesn't list the
 * storefront's verify origin (:4000), but server→backend requests aren't subject
 * to it. The client learns the auth state via the same-origin `/api/me` route.
 */
import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import type { HttpTypes } from '@medusajs/types';
import { sdk } from '@/lib/medusa';
import { authedFetch } from '@/lib/authed-fetch';
import { httpStatus } from '@/lib/errors';

const AUTH_COOKIE = '_polycards_jwt';
// Matches the backend's `jwtExpiresIn` default ("1d", medusa-config.ts sets
// none) — a longer cookie only outlives its JWT and reads as "logged in" while
// every backend call 401s.
const COOKIE_MAX_AGE = 60 * 60 * 24; // 1 day

const OAUTH_STATE_COOKIE = '_polycards_oauth';
const OAUTH_COOKIE_PATH = '/auth/google';

/** Persist the customer JWT (call only from a server action or route handler). */
export async function setAuthToken(token: string): Promise<void> {
  const store = await cookies();
  store.set(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
}

/** Clear the customer JWT (call only from a server action or route handler). */
export async function clearAuthToken(): Promise<void> {
  const store = await cookies();
  store.delete(AUTH_COOKIE);
}

/**
 * Bind a Google OAuth `state` to THIS browser for the return leg. The backend
 * only checks that a state exists in its store, so without this any browser
 * presenting a valid code+state pair is logged in as whoever completed the
 * consent — login-CSRF (the attacker's session on the victim's browser, and
 * the victim's top-ups in the attacker's wallet). Scoped to the callback path;
 * 10 minutes outlives any consent screen.
 */
export async function setOauthState(state: string): Promise<void> {
  const store = await cookies();
  store.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: OAUTH_COOKIE_PATH,
    maxAge: 600,
  });
}

/** Read AND clear the bound state — single use, so a replayed callback URL
 *  fails the same way a foreign one does. */
export async function takeOauthState(): Promise<string | undefined> {
  const store = await cookies();
  const state = store.get(OAUTH_STATE_COOKIE)?.value;
  // Path must match the setter's or the browser keeps the original cookie.
  store.delete({ name: OAUTH_STATE_COOKIE, path: OAUTH_COOKIE_PATH });
  return state;
}

/**
 * The raw customer JWT from the httpOnly cookie, or undefined when logged out.
 * Server-only — data getters and server actions pass it to `authedFetch`
 * (src/lib/authed-fetch.ts), which attaches the explicit `Authorization: Bearer`
 * the backend needs (browser auth is CORS-blocked at :4000).
 *
 * The `if (!token) return …` that follows every call is NOT boilerplate: what a
 * logged-out caller answers with differs on purpose per module, which is why
 * this read stays at the call site rather than inside `authedFetch`.
 */
export async function getAuthToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(AUTH_COOKIE)?.value;
}

/**
 * The logged-in customer (from the httpOnly JWT cookie), or null if logged out
 * — plus whether the cookie is STALE: a token the backend rejected outright
 * (401 — expired or revoked). Only a 401 counts; a 5xx or a network drop is
 * the backend's problem, not the session's, and must never reap the cookie.
 * /api/me — the one request every page load makes, and a Route Handler that
 * may mutate cookies — clears a stale cookie so the dead token stops reading
 * as "logged in" everywhere that only checks its presence.
 *
 * `cache()`-wrapped so the account layout's auth gate and the page that renders
 * inside it share a single backend round-trip per request instead of two.
 */
export const getCustomerSession = cache(
  async (): Promise<{
    customer: HttpTypes.StoreCustomer | null;
    stale: boolean;
  }> => {
    const token = await getAuthToken();
    if (!token) return { customer: null, stale: false };
    try {
      const { customer } = await sdk.store.customer.retrieve(
        { fields: '+metadata' },
        { Authorization: `Bearer ${token}` },
      );
      return { customer, stale: false };
    } catch (error) {
      // Expired/invalid token — treat as logged out.
      return { customer: null, stale: httpStatus(error) === 401 };
    }
  },
);

/** The logged-in customer, or null if logged out (see getCustomerSession). */
export async function getCustomer(): Promise<HttpTypes.StoreCustomer | null> {
  return (await getCustomerSession()).customer;
}

/**
 * Update the logged-in customer's own profile (data layer — no validation here).
 * Throws when logged out so the calling server action can surface a clean error;
 * `email` is intentionally not part of `StoreUpdateCustomer` (not updatable here).
 */
export async function updateCustomerProfile(
  body: HttpTypes.StoreUpdateCustomer,
): Promise<HttpTypes.StoreCustomer> {
  const token = await getAuthToken();
  if (!token) throw new Error('Not authenticated.');
  const { customer } = await sdk.store.customer.update(
    body,
    {},
    {
      Authorization: `Bearer ${token}`,
    },
  );
  return customer;
}

export type AccountInfo = { hasPassword: boolean };

/**
 * Account facts the Settings page needs before rendering the Danger zone.
 *
 * `hasPassword` is false for a Google-only signup, which removes the password
 * field from the delete confirmation. Defaults to `true` on any failure — the
 * safer shape, since it asks for MORE proof rather than less. Getting it wrong
 * the other way would drop the password field for an account that does have
 * one, and every delete would then fail PASSWORD_REQUIRED with no way to
 * comply.
 */
export async function getAccountInfo(): Promise<AccountInfo> {
  const token = await getAuthToken();
  if (!token) return { hasPassword: true };
  try {
    return await authedFetch<AccountInfo>(token, '/store/customers/me/account');
  } catch {
    return { hasPassword: true };
  }
}
