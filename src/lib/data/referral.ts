/**
 * Referral data seam for the /referral page (rebuild, spec 2026-08-24).
 * Server-side authed fetch, zod-validated (looseObject per house style), null
 * on any failure — the page then renders its logged-out / unavailable panel
 * instead of crashing.
 */
import 'server-only';
import { authedFetch } from '@/lib/authed-fetch';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import {
  parseOne,
  ReferralSummarySchema,
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
