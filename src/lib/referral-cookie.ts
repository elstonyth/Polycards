/**
 * Referral invite cookie (rebuild, spec 2026-08-24). /invite/<handle> plants
 * it; signup consumes it. Attribution is permanent and binds at signup only,
 * so the cookie is short-lived state, not an account property.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';

export const REFERRAL_COOKIE = '_polycards_ref';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** Mirrors the backend's HANDLE_RE (utils/profile-handle.ts) — the backend
 *  re-validates, this just keeps junk out of the cookie. */
export const INVITE_HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/;

export async function setReferralCookie(handle: string): Promise<void> {
  const store = await cookies();
  store.set(REFERRAL_COOKIE, handle, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function readReferralCookie(): Promise<string | null> {
  const store = await cookies();
  const v = store.get(REFERRAL_COOKIE)?.value;
  return v && INVITE_HANDLE_RE.test(v) ? v : null;
}

export async function clearReferralCookie(): Promise<void> {
  const store = await cookies();
  store.delete(REFERRAL_COOKIE);
}

/**
 * Fire the one-shot attribution bind for the just-signed-up customer. Called
 * from the signup action AFTER login succeeded; every failure path is
 * swallowed (logged) — signup must NEVER fail on a referral hiccup. The
 * cookie is cleared whatever the outcome: the backend refuses a second bind
 * anyway, so retrying a stale cookie only burns rate-limit budget.
 */
export async function bindReferralFromCookie(): Promise<void> {
  try {
    const handle = await readReferralCookie();
    if (!handle) return;
    const token = await getAuthToken();
    if (!token) return;
    await sdk.client.fetch('/store/referral/bind', {
      method: 'POST',
      body: { referrer_handle: handle },
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch (error) {
    logger.error('[referral] bind after signup failed:', error);
  } finally {
    await clearReferralCookie().catch(() => {});
  }
}
