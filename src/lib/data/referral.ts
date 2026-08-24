/**
 * Referral + VIP rebate data seams for the /task hub (rebuild, spec
 * 2026-08-24). Server-side authed fetches, zod-validated (looseObject per
 * house style), null on any failure — the tabs then render their logged-out /
 * unavailable panel instead of crashing the page.
 */
import 'server-only';
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import {
  parseOne,
  ReferralSummarySchema,
  VipRebateSchema,
  type ReferralSummary,
  type VipRebate,
} from '@/lib/data/schemas';

export async function getReferralSummary(): Promise<ReferralSummary | null> {
  const token = await getAuthToken();
  if (!token) return null;
  try {
    const raw = await sdk.client.fetch('/store/referral', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    return parseOne(ReferralSummarySchema, raw);
  } catch (error) {
    logger.error('[referral] summary load failed:', error);
    return null;
  }
}

export async function getVipRebate(): Promise<VipRebate | null> {
  const token = await getAuthToken();
  if (!token) return null;
  try {
    const raw = await sdk.client.fetch('/store/vip-rebate', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    return parseOne(VipRebateSchema, raw);
  } catch (error) {
    logger.error('[referral] vip-rebate load failed:', error);
    return null;
  }
}
