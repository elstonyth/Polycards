'use server';

/**
 * VIP server action — reads the customer's VIP level, cumulative spend, and
 * next-rung reward teaser.
 *
 * Backend route: GET /store/vip
 * Wire shape (snake_case, all at root level):
 *   { level, highest_level_ever, spend, next: { level, threshold, remaining,
 *     reward: { voucher_amount, box_tier, frame_unlock } } | null }
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { friendlyError, isAuthError, type ErrorRule } from '@/lib/errors';
import { parseOne, VipSchema } from '@/lib/data/schemas';

export type VipReward = {
  voucherAmount: number;
  boxTier: string;
  frameUnlock: boolean;
};

export type VipNext = {
  level: number;
  threshold: number;
  remaining: number;
  reward: VipReward;
};

export type Vip = {
  level: number;
  highestLevelEver: number;
  spend: number;
  next: VipNext | null;
};

export type VipResult =
  | { ok: true; vip: Vip }
  | { ok: false; error: string; needsAuth?: boolean };

const VIP_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    'Too many requests — give it a moment and try again.',
  ],
  [
    /unauthorized|not authenticated|401/i,
    'Please log in to view your VIP status.',
  ],
];
const VIP_FALLBACK = 'Something went wrong. Please try again.';

export async function getVip(): Promise<VipResult> {
  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to view your VIP status.',
      needsAuth: true,
    };
  }

  try {
    const raw = await sdk.client.fetch('/store/vip', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });

    const v = parseOne(VipSchema, raw);
    if (!v) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }

    return {
      ok: true,
      vip: {
        level: v.level,
        highestLevelEver: v.highest_level_ever,
        spend: v.spend,
        next: v.next
          ? {
              level: v.next.level,
              threshold: v.next.threshold,
              remaining: v.next.remaining,
              reward: {
                voucherAmount: v.next.reward.voucher_amount,
                boxTier: v.next.reward.box_tier,
                frameUnlock: v.next.reward.frame_unlock,
              },
            }
          : null,
      },
    };
  } catch (error) {
    logger.error('[vip] load failed:', error);
    return {
      ok: false,
      error: friendlyError(error, VIP_RULES, VIP_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}
