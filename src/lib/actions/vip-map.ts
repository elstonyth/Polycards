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
    directReferralPct: number;
  };
};

export type RawVipLevel = {
  level: number;
  threshold: number;
  reward: {
    voucher_amount: number;
    box_tier: string;
    frame_unlock: boolean;
    direct_referral_pct: number;
  };
};

export function mapVipLevels(raw: RawVipLevel[]): VipLevel[] {
  return raw.map((r) => ({
    level: r.level,
    threshold: r.threshold,
    reward: {
      voucherAmount: r.reward.voucher_amount,
      boxTier: r.reward.box_tier,
      frameUnlock: r.reward.frame_unlock,
      directReferralPct: r.reward.direct_referral_pct,
    },
  }));
}
