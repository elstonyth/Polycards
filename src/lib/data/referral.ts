/**
 * Referral data seam for the /referral page and the /r/<code> link (rebuild,
 * spec 2026-08-24). Server-side fetches, zod-validated (looseObject per house
 * style), never a throw — the page renders its logged-out / unavailable panel
 * and the link route falls back explicitly instead of crashing.
 */
import 'server-only';
import { cache } from 'react';
import { sdk } from '@/lib/medusa';
import { authedFetch } from '@/lib/authed-fetch';
import { httpStatus } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import {
  parseOne,
  ReferralCodeLookupSchema,
  ReferralSummarySchema,
  type ReferralCodeLookup,
  type ReferralSummary,
} from '@/lib/data/schemas';

export async function getReferralSummary(): Promise<ReferralSummary | null> {
  const token = await getAuthToken();
  if (!token) return null;
  try {
    const raw = await authedFetch(token, '/store/referral');
    return parseOne(ReferralSummarySchema, raw);
  } catch (error) {
    logger.error('[referral] summary load failed:', error);
    return null;
  }
}

export type ReferralCodeLookupResult =
  | ({ status: 'ok' } & ReferralCodeLookup)
  | { status: 'notfound' }
  | { status: 'error' };

/**
 * PUBLIC "who owns this code" check (GET /store/referral/codes/:code) behind
 * the /r/<code> link and the signup form. A STATUS UNION, never a throw:
 * 'notfound' is a dead code or a hidden (disabled) referrer — both
 * un-bindable — and 'error' is OUR outage, which callers treat as "carry on,
 * the bind re-validates". Expects an already-normalized code.
 */
export const lookupReferralCode = cache(
  async (code: string): Promise<ReferralCodeLookupResult> => {
    try {
      const raw = await sdk.client.fetch<unknown>(
        `/store/referral/codes/${encodeURIComponent(code)}`,
      );
      const parsed = parseOne(ReferralCodeLookupSchema, raw);
      if (!parsed) {
        logger.error(`[referral] code lookup schema mismatch for "${code}"`);
        return { status: 'error' };
      }
      return { status: 'ok', ...parsed };
    } catch (error) {
      if (httpStatus(error) === 404) {
        return { status: 'notfound' };
      }
      logger.error(`[referral] code lookup failed for "${code}":`, error);
      return { status: 'error' };
    }
  },
);
