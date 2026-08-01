/**
 * SUSPENDED 2026-07-29 — the `/vip` route was deleted with the reward
 * surfaces (docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md).
 * Kept unreferenced, not deleted, so un-suspending is a revert rather than a
 * rewrite; the backend routes these call are all still live.
 *
 * Note: the perk strings below describe the suspended reward economy (box
 * tiers, referral rates) — verify they still match current VIP-level rewards
 * before un-suspending, don't assume they aged perfectly.
 */
import type { VipLevel } from '@/lib/actions/vip';

export type Milestone = { level: number; perks: string[] };

/**
 * The "big" VIP perks by level: frame unlocks, daily-box tier upgrades, and
 * referral-rate bumps — i.e. rungs where something changes vs the previous
 * rung. Per-level vouchers are shown on the carousel cards, not here, so this
 * summary stays scannable. L1 has no prior to compare, so it never emits a
 * change row (frame_unlock is false at L1 anyway).
 */
export function milestoneBenefits(levels: VipLevel[]): Milestone[] {
  const out: Milestone[] = [];
  let prevTier: string | null = null;
  let prevReferral: number | null = null;
  for (const l of levels) {
    const perks: string[] = [];
    if (l.reward.frameUnlock) perks.push('New avatar frame');
    if (prevTier !== null && l.reward.boxTier !== prevTier) {
      perks.push(
        `Daily box upgrades to Tier ${l.reward.boxTier.toUpperCase()}`,
      );
    }
    if (prevReferral !== null && l.reward.directReferralPct !== prevReferral) {
      perks.push(`Referral rate → ${l.reward.directReferralPct}%`);
    }
    if (perks.length > 0) out.push({ level: l.level, perks });
    prevTier = l.reward.boxTier;
    prevReferral = l.reward.directReferralPct;
  }
  return out;
}
