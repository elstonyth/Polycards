'use server';

/**
 * Referral server actions — summary read + apply-sponsor write.
 *
 * Backend routes:
 *   GET  /store/referral              — referral summary (directRecruits, downstreamCount, totalEarned)
 *   POST /store/referral              — apply a sponsor (body: { sponsor_handle })
 *
 * Wire shape for GET (camelCase already on the wire — backend emits camelCase):
 *   { directRecruits: [{ handle: string|null, contribution: number }],
 *     downstreamCount: number, totalEarned: number }
 *
 * Wire shape for POST:
 *   Body:     { sponsor_handle: string }
 *   Response: { id: string }
 *
 * Guard errors mapped through friendlyError:
 *   /already has a sponsor/i, /cycle/i, /self/i, /too many|429/i,
 *   /no such referral handle/i
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { friendlyError, isAuthError, type ErrorRule } from '@/lib/errors';
import {
  parseOne,
  ReferralSummarySchema,
  ReferralApplySchema,
} from '@/lib/data/schemas';

export type DirectRecruit = {
  handle: string | null;
  contribution: number;
};

export type ReferralSummary = {
  directRecruits: DirectRecruit[];
  downstreamCount: number;
  totalEarned: number;
};

export type ReferralSummaryResult =
  | {
      ok: true;
      directRecruits: DirectRecruit[];
      downstreamCount: number;
      totalEarned: number;
    }
  | { ok: false; error: string; needsAuth?: boolean };

export type ApplyReferralResult =
  | { ok: true; id: string }
  | { ok: false; error: string; needsAuth?: boolean };

const REFERRAL_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    'Too many requests — give it a moment and try again.',
  ],
  [/already has a sponsor/i, 'You already have a sponsor set.'],
  [/cycle/i, 'This would create a referral cycle — not allowed.'],
  [/self.?referral|refers? (to )?themselves?/i, 'You cannot refer yourself.'],
  [/no such referral handle/i, 'That referral handle does not exist.'],
  [/unauthorized|not authenticated|401/i, 'Please log in first.'],
];
const REFERRAL_FALLBACK = 'Something went wrong. Please try again.';

export async function getReferralSummary(): Promise<ReferralSummaryResult> {
  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to view your referrals.',
      needsAuth: true,
    };
  }

  try {
    const raw = await sdk.client.fetch('/store/referral', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });

    const summary = parseOne(ReferralSummarySchema, raw);
    if (!summary) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }

    // directRecruits is already validated by ReferralSummarySchema (z.array(...))
    // — no second parseList needed; the parsed rows are already type-safe.
    return {
      ok: true,
      directRecruits: summary.directRecruits,
      downstreamCount: summary.downstreamCount,
      totalEarned: summary.totalEarned,
    };
  } catch (error) {
    logger.error('[referral] summary load failed:', error);
    return {
      ok: false,
      error: friendlyError(error, REFERRAL_RULES, REFERRAL_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

export async function applyReferral(
  handle: string,
): Promise<ApplyReferralResult> {
  // Validate at the boundary — server actions are public endpoints.
  if (typeof handle !== 'string' || handle.trim() === '') {
    return { ok: false, error: 'A referral handle is required.' };
  }

  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }

  try {
    const raw = await sdk.client.fetch('/store/referral', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { sponsor_handle: handle },
    });

    const parsed = parseOne(ReferralApplySchema, raw);
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }

    return { ok: true, id: parsed.id };
  } catch (error) {
    logger.error('[referral] apply failed:', error);
    return {
      ok: false,
      error: friendlyError(error, REFERRAL_RULES, REFERRAL_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}
