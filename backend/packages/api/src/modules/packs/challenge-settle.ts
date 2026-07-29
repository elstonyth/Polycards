import type { ChallengeRankReward } from './challenge-validate';

/** Stage projection settlement needs (matches listChallengeStages select). */
export interface SettleStage {
  stage_number: number;
  threshold_myr: number;
  rank_rewards: ChallengeRankReward[];
}

/** Stages the final pool unlocked — >= is inclusive (spec rule 3). */
export function unlockedStages(
  stages: SettleStage[],
  poolMyr: number,
): SettleStage[] {
  return stages
    .filter((s) => poolMyr >= s.threshold_myr)
    .sort((a, b) => a.stage_number - b.stage_number);
}

export interface RankPayout {
  rank: number;
  credits: number;
  cardIds: string[]; // may repeat — same card from two stages = two copies
}

/** Union of every unlocked stage's prize table, keyed by rank (spec rule 5):
 *  credits summed, card ids collected in stage order. Ranks absent from all
 *  tables are absent from the map. */
export function payoutByRank(
  unlocked: SettleStage[],
): Map<number, RankPayout> {
  const by = new Map<number, RankPayout>();
  for (const s of unlocked) {
    for (const r of s.rank_rewards) {
      const cur = by.get(r.rank) ?? { rank: r.rank, credits: 0, cardIds: [] };
      cur.credits += r.credits;
      if (r.card_id) cur.cardIds.push(r.card_id);
      by.set(r.rank, cur);
    }
  }
  return by;
}
