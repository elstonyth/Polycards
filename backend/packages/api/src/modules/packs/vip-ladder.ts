import { toSen } from './money';

// Pure VIP-level derivation. Kept here (no DB) so the math is unit-testable like
// credit-summary.ts. Level = the highest rung whose cumulative spend_threshold is met,
// compared in integer sen so sub-sen float noise can't cross a boundary.
export type VipLevelRow = {
  level: number;
  spend_threshold: number;
};

export function levelForSpend(spend: number, ladder: VipLevelRow[]): number {
  if (ladder.length === 0) {
    throw new Error('levelForSpend: ladder is empty');
  }
  const spendSen = toSen(spend);

  let best: number | null = null;
  let lowest = ladder[0].level;
  for (const row of ladder) {
    if (row.level < lowest) lowest = row.level;
    if (toSen(row.spend_threshold) <= spendSen) {
      if (best === null || row.level > best) best = row.level;
    }
  }
  // Below the lowest threshold (defensive — L1 threshold is 0, so spend>=0 always qualifies).
  return best ?? lowest;
}
