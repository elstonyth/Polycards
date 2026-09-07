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
import { store } from '@/lib/store';
import { AccountInfoSchema } from '@/lib/data/schemas';
import { httpStatus } from '@/lib/errors';
// The cookie name lives with the port that reads it (src/lib/store.ts); this
// module only sets and clears it.
import { AUTH_COOKIE } from '@/lib/store-port';

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
 * Server-only.
 *
 * Backend CALLS no longer come through here — the `Store` port reads the same
 * cookie itself (src/lib/store.ts). What is left are the three reasons a
 * caller still needs the token in hand:
 *
 * - **Cookie PRESENCE as a fact**, not as a bearer: /task and /referral fold
 *   it into `isLoggedIn`, /api/free-pack picks its cache regime from it,
 *   /r/<code> refuses to plant an invite cookie for a signed-in visitor, and
 *   data/free-pack.ts needs to know which of two answers it is reading.
 * - **`sdk.store.*` / `sdk.auth.*` calls**, which take headers positionally
 *   and so build their own `Authorization` (getCustomerSession and
 *   updateCustomerProfile below; the address-book calls in actions/delivery.ts).
 * - **The multipart avatar upload** (actions/profile-appearance.ts), which
 *   reads the cookie directly for the same reason: `sdk.client.fetch`
 *   JSON-stringifies bodies and cannot carry a FormData boundary.
 *
 * A token that must be sent as a bearer WITHOUT being the cookie's — the
 * post-register refresh, fetchProfileHandle — uses the port's `bearer`
 * option instead.
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
 * Account facts the Settings page needs before rendering the Danger zone, and
 * the account layout needs for the required-phone gate (shouldGatePhone).
 *
 * `hasPassword` is false for a Google-only signup, which removes the password
 * field from the delete confirmation. Defaults to `true` on any failure — the
 * safer shape, since it asks for MORE proof rather than less. Getting it wrong
 * the other way would drop the password field for an account that does have
 * one, and every delete would then fail PASSWORD_REQUIRED with no way to
 * comply. For the phone gate the same default means NO gate on a failed read
 * (fail-open); that is deliberate — the backend money/goods gates are the
 * enforcement, and a gate raised on a password account can never be completed.
 *
 * Request-scoped cache: the layout and /settings both read it on a gated
 * request.
 */
export const getAccountInfo = cache(async (): Promise<AccountInfo> => {
  const r = await store.get(
    '/store/customers/me/account',
    AccountInfoSchema,
    // Explicit, though it is the default — this one is per-customer and must
    // never be cached or answered for a guest.
    { auth: 'required' },
  );
  return r.ok ? r.data : { hasPassword: true };
});
