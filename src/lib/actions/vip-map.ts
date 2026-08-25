/**
 * Pure helper for mapping the raw VIP ladder into `VipLevel[]`.
 *
 * Extracted from the 'use server' boundary (same pattern as
 * pack-batch-map.ts / vault-map.ts) so this module can be imported by unit
 * tests without the Next.js server-action constraint (which disallows
 * non-async named exports from a 'use server' file).
 *
 * Nothing in here is server-only — no SDK, no auth, no secrets.
 */

export type VipLevel = {
  level: number;
  threshold: number;
  reward: {
    voucherAmount: number;
    boxTier: string;
    frameUnlock: boolean;
  };
};

export type RawVipLevel = {
  level: number;
  threshold: number;
  reward: {
    voucher_amount: number;
    box_tier: string;
    frame_unlock: boolean;
  };
};

/**
 * Progress (0-100) through one level's spend segment [start, end] — the bar
 * restarts at each level instead of filling with lifetime spend, so mid-level
 * progress reads as ~50%, not ~98%. Degenerate segments (end <= start, e.g.
 * the L1 base rung) count as complete.
 */
export function levelProgressPct(
  spend: number,
  start: number,
  end: number,
): number {
  if (end <= start) return 100;
  return Math.min(
    100,
    Math.max(0, Math.round(((spend - start) / (end - start)) * 100)),
  );
}

export function mapVipLevels(raw: RawVipLevel[]): VipLevel[] {
  return raw.map((r) => ({
    level: r.level,
    threshold: r.threshold,
    reward: {
      voucherAmount: r.reward.voucher_amount,
      boxTier: r.reward.box_tier,
      frameUnlock: r.reward.frame_unlock,
    },
  }));
}
