'use server';

/**
 * VIP server action — reads the customer's VIP level, cumulative spend, and
 * next-rung threshold.
 *
 * Backend route: GET /store/vip
 * Wire shape (snake_case, all at root level):
 *   { level, highest_level_ever, spend, next: { level, threshold, remaining,
 *     reward: { voucher_amount, box_tier, frame_unlock } } | null }
 *
 * `next.reward` is on the wire but is neither validated nor mapped — nothing
 * renders it, and declaring it let a malformed reward blank the LV card (#523).
 * It stays documented here so the wire shape above is still the truth.
 */
import { authedFetch } from '@/lib/authed-fetch';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { friendlyError, isAuthError, type ErrorRule } from '@/lib/errors';
import { parseOne, VipSchema } from '@/lib/data/schemas';
// mapVipLevels is a sync helper, so it lives in ./vip-map.ts rather than here
// — a 'use server' file may only export async functions as values (same
// reason pack-batch-map.ts / vault-map.ts exist). Re-export the type only.
import { mapVipLevels, type VipLevel } from './vip-map';
export type { VipLevel } from './vip-map';

/**
 * The next-rung teaser.
 *
 * No `reward`, deliberately. The backend sends one and every `levels` row
 * carries the same block, but nothing on any surface has ever rendered the
 * TEASER's copy of it -- me/page.tsx reads only level, threshold and
 * remaining. Declaring it made a required, un-caught schema field out of dead
 * data, which is how a malformed reward could blank the whole LV card (#523).
 * VipLevel keeps its own reward: vip-benefits.ts genuinely reads that one.
 */
export type VipNext = {
  level: number;
  threshold: number;
  remaining: number;
};

export type Vip = {
  level: number;
  highestLevelEver: number;
  spend: number;
  next: VipNext | null;
  levels: VipLevel[];
};

export type VipResult =
  { ok: true; vip: Vip } | { ok: false; error: string; needsAuth?: boolean };

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
    const raw = await authedFetch(token, '/store/vip');

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
            }
          : null,
        levels: mapVipLevels(v.levels),
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
