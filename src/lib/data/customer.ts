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

const AUTH_COOKIE = '_polycards_jwt';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

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
 * The raw customer JWT from the httpOnly cookie, or undefined when logged out.
 * Server-only — used by data getters and server actions to send an explicit
 * `Authorization: Bearer` to the backend (browser auth is CORS-blocked at :4000).
 */
export async function getAuthToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(AUTH_COOKIE)?.value;
}

/**
 * The logged-in customer (from the httpOnly JWT cookie), or null if logged out.
 *
 * `cache()`-wrapped so the account layout's auth gate and the page that renders
 * inside it share a single backend round-trip per request instead of two.
 */
export const getCustomer = cache(
  async (): Promise<HttpTypes.StoreCustomer | null> => {
    const token = await getAuthToken();
    if (!token) return null;
    try {
      const { customer } = await sdk.store.customer.retrieve(
        { fields: '+metadata' },
        { Authorization: `Bearer ${token}` },
      );
      return customer;
    } catch {
      // Expired/invalid token — treat as logged out.
      return null;
    }
  },
);

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

export type AccountInfo = {
  hasPassword: boolean;
  /** Why the account is disabled, or null when it is not. Only 'self' may be
   *  offered reactivation — see the route's comment for why login reads this
   *  field instead of watching for a 403. */
  disabledCause: 'admin' | 'self' | null;
};

/**
 * Account facts for an EXPLICIT token, propagating failures.
 *
 * Separate from `getAccountInfo` because it runs before the cookie is readable —
 * the token is minted in the same request — and the pair mirrors
 * `fetchProfileHandle`/`getOwnProfileHandle` next door.
 *
 * It still propagates, but note what its only two callers do with that:
 * `login` and `googleCallback` (src/lib/actions/auth.ts) BOTH catch it to
 * `ASSUME_ACTIVE`, because a rejection there lands in the catch that clears the
 * auth cookie and would fail a login whose password was correct — see that
 * constant for the full reasoning and the trade it accepts. So the
 * propagate/swallow split is nominal at today's call sites; the propagation is
 * kept so a new caller must decide for itself rather than inherit a silent
 * "not disabled" it never asked for.
 */
export async function fetchAccountInfo(token: string): Promise<AccountInfo> {
  return await sdk.client.fetch<AccountInfo>('/store/customers/me/account', {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
}

/**
 * Account facts the Settings page needs before rendering the Danger zone.
 *
 * `hasPassword` is false for a Google-only signup, which removes the password
 * field from the delete confirmation. Defaults to `true` on any failure — the
 * safer shape, since it asks for MORE proof rather than less. (Getting it wrong
 * the other way would drop the password field for an account that does have
 * one, and every delete would then fail PASSWORD_REQUIRED with no way to
 * comply.) `disabledCause` falls back to null for the same reason in reverse:
 * a guessed disable state must never drive UI that a real one would.
 */
export async function getAccountInfo(): Promise<AccountInfo> {
  const token = await getAuthToken();
  if (!token) return { hasPassword: true, disabledCause: null };
  try {
    return await fetchAccountInfo(token);
  } catch {
    return { hasPassword: true, disabledCause: null };
  }
}
