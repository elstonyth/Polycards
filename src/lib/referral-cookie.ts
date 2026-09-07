/**
 * Referral cookie (rebuild, spec 2026-08-24; code-based since 2026-09-03).
 * /r/<code> plants it; signup consumes it. Attribution is permanent and binds
 * at signup only, so the cookie is short-lived state, not an account property.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { store } from '@/lib/store';
import { UncheckedSchema } from '@/lib/data/schemas';
import { logger } from '@/lib/logger';
import { normalizeReferralCode } from '@/lib/referral-code';

export const REFERRAL_COOKIE = '_polycards_ref';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function setReferralCookie(code: string): Promise<void> {
  const store = await cookies();
  store.set(REFERRAL_COOKIE, code, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
}

/** The planted code, or null — a pre-2026-09 handle cookie normalizes to
 *  null and is simply ignored. */
export async function readReferralCookie(): Promise<string | null> {
  const store = await cookies();
  return normalizeReferralCode(store.get(REFERRAL_COOKIE)?.value);
}

export async function clearReferralCookie(): Promise<void> {
  const store = await cookies();
  store.delete(REFERRAL_COOKIE);
}

/**
 * Fire the one-shot attribution bind for the just-signed-up customer. Called
 * from the signup paths AFTER login succeeded. `code` is what the form carried
 * (already normalized by the action); when absent — the Google path, or a
 * form left blank — the /r/<code> cookie is the fallback. Every failure path
 * is swallowed (logged): signup must NEVER fail on a referral hiccup. The
 * cookie is cleared whatever the outcome — the backend refuses a second bind
 * anyway, so retrying a stale cookie only burns rate-limit budget.
 */
export async function bindReferral(code: string | null = null): Promise<void> {
  try {
    const referrerCode = code ?? (await readReferralCookie());
    if (!referrerCode) return;
    // The bind's answer is ignored — a 2xx IS the answer — so no schema. The
    // port's default auth: 'required' is the old `if (!token) return`: no
    // cookie means no request leaves at all, and a failure it DID make is
    // logged once by the port. The catch below stays for the cookie reads,
    // which can still throw: a referral hiccup must never fail a signup.
    await store.post('/store/referral/bind', UncheckedSchema, {
      referrer_code: referrerCode,
    });
  } catch (error) {
    logger.error('[referral] bind after signup failed:', error);
  } finally {
    await clearReferralCookie().catch(() => {});
  }
}
