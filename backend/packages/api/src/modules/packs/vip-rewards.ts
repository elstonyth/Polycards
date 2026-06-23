// src/modules/packs/vip-rewards.ts
export type RewardKind = 'voucher' | 'frame' | 'box';
export type Reward = { kind: RewardKind; payload: Record<string, unknown> };

// Levels gained this open. L1 is a non-granting entry tier (D8): start at 2.
export function levelsToGrant(highestEver: number, newLevel: number): number[] {
  const start = Math.max(highestEver + 1, 2);
  const out: number[] = [];
  for (let L = start; L <= newLevel; L++) out.push(L);
  return out;
}

// Ladder rewards for ONE level (L≥2). Snapshot values into payload (immune to
// later admin ladder edits, like commission.effective_pct). Box is per-rung with
// its tier (additive-vs-replacement resolved at the deferred fulfillment phase,
// D6). 'prize' is never granted in 3b (D7).
export function rewardsForLevel(row: {
  level: number;
  voucher_amount: number;
  box_tier: string;
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
  out.push({ kind: 'box', payload: { tier: row.box_tier } });
  return out;
}
