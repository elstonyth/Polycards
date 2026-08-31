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
