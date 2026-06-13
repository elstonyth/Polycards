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
import { logger } from '@/lib/logger';

const AUTH_COOKIE = '_pokenic_jwt';
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
        {},
        { Authorization: `Bearer ${token}` },
      );
      return customer;
    } catch {
      // Expired/invalid token — treat as logged out.
      return null;
    }
  },
);

// Order list field selection (verified against the backend): scalar order facts
// plus the line items. The Store API doesn't guarantee an order without an
// explicit sort, so `getOrders` sorts newest-first after fetching.
const ORDER_FIELDS =
  'id,display_id,status,fulfillment_status,payment_status,total,currency_code,created_at,*items';
const ORDER_LIST_LIMIT = 50;

/**
 * The logged-in customer's orders (newest first), or `[]` when logged out or the
 * backend is unreachable. Empty until the Phase 5 checkout flow creates orders —
 * that empty result is expected, not a failure.
 */
export async function getOrders(): Promise<HttpTypes.StoreOrder[]> {
  const token = await getAuthToken();
  if (!token) return [];
  try {
    const { orders } = await sdk.store.order.list(
      { limit: ORDER_LIST_LIMIT, fields: ORDER_FIELDS },
      { Authorization: `Bearer ${token}` },
    );
    return [...orders].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  } catch (error) {
    logger.error('[orders] failed to load orders from backend:', error);
    return [];
  }
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
