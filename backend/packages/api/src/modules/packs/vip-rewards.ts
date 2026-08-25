// src/modules/packs/vip-rewards.ts

// Full set of kinds the vip_reward_grant model / DB column recognises.
// Must stay in sync with the model enum ['voucher','frame','box','prize'].
export type RewardKind = 'voucher' | 'frame' | 'box' | 'prize';

// Subset actually emitted by rewardsForLevel (box derives live at draw time B6;
// prize is never granted per-rung D7). Narrower return type preserves safety
// without clashing with the broader persisted model enum.
export type EmittedRewardKind = 'voucher' | 'frame';
export type Reward = { kind: EmittedRewardKind; payload: Record<string, unknown> };

// Levels gained this open. L1 is a non-granting entry tier (D8): start at 2.
export function levelsToGrant(highestEver: number, newLevel: number): number[] {
  const start = Math.max(highestEver + 1, 2);
  const out: number[] = [];
  for (let L = start; L <= newLevel; L++) out.push(L);
  return out;
}

// Ladder rewards for ONE level (L≥2). Snapshot values into payload (immune to
// later admin ladder edits, like commission.effective_pct). 'prize' is never
// granted here (D7), and the daily box it used to pick a tier for was removed
// 2026-08-25 — voucher and frame are all a rung grants.
export function rewardsForLevel(row: {
  level: number;
  voucher_amount: number;
  frame_unlock: boolean;
}): Reward[] {
  const out: Reward[] = [];
  if (Number(row.voucher_amount) > 0)
    out.push({
      kind: 'voucher',
      payload: { amount_myr: Number(row.voucher_amount) },
    });
  if (row.frame_unlock)
    out.push({ kind: 'frame', payload: { level: row.level } });
  return out;
}
