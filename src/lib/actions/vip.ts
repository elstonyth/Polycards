'use server';

/**
 * VIP server action — reads the customer's VIP level, cumulative spend, and
 * next-rung threshold.
 *
 * Backend route: GET /store/vip
 * Wire shape (snake_case, all at root level):
 *   { level, highest_level_ever, spend, next: { level, threshold, remaining,
 *     reward: { voucher_amount, frame_unlock } } | null }
 *   (`box_tier` left the wire with #490; the schema tolerates it as optional)
 *
 * The call goes through the `Store` port (src/lib/store.ts), which owns the
 * cookie read, the bearer, the schema check and the failure log; what stays
 * here is the logged-out answer and the copy (`vipFailure`, over VIP_RULES).
 *
 * `next.reward` is on the wire but is neither validated nor mapped — nothing
 * renders it, and declaring it let a malformed reward blank the LV card (#523).
 * It stays documented here so the wire shape above is still the truth.
 */
import { store, type Failure } from '@/lib/store';
import { friendlyError, type ErrorRule } from '@/lib/errors';
import { VipSchema } from '@/lib/data/schemas';
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
const LOGIN_TO_VIEW_VIP = 'Please log in to view your VIP status.';

/** A port `Failure` in this action's vocabulary: no cookie at all (the call
 *  never left — `status` is undefined) and a 2xx that failed VipSchema each
 *  keep their own copy; anything the backend actually said goes through
 *  VIP_RULES, with `needsAuth` when it was a 401. */
function vipFailure(f: Failure): VipResult {
  if (f.kind === 'invalid_shape') {
    return {
      ok: false,
      error: 'Got an unexpected response. Please try again.',
    };
  }
  if (f.kind === 'unauthenticated' && f.status === undefined) {
    return { ok: false, error: LOGIN_TO_VIEW_VIP, needsAuth: true };
  }
  return {
    ok: false,
    error: friendlyError(f.text, VIP_RULES, VIP_FALLBACK),
    needsAuth: f.kind === 'unauthenticated',
  };
}

export async function getVip(): Promise<VipResult> {
  const r = await store.get('/store/vip', VipSchema);
  if (!r.ok) return vipFailure(r);
  const v = r.data;

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
}
