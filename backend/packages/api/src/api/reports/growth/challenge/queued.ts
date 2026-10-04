import type PacksModuleService from '../../../../modules/packs/service';
import type { ChallengeRankReward } from '../../../../modules/packs/challenge-validate';

export type QueuedChallenge = {
  startsAt: Date;
  label: string | null;
  stages: {
    stageNumber: number;
    thresholdMyr: number;
    rankRewards: { rank: number; cardId: string | null; credits: number }[];
  }[];
  /** Each prize card's name and official art (the graded slab preferred). */
  cards: Record<string, { name: string; image: string }>;
};

/**
 * The next Weekly Challenge waiting in the admin queue (challenge_schedule):
 * the soonest edition not yet promoted to live, in the same shape the
 * running week's view uses. null when the queue is empty.
 */
export async function nextQueuedChallenge(
  packs: PacksModuleService,
): Promise<QueuedChallenge | null> {
  const [row] = await packs.listChallengeSchedules(
    { applied_at: null },
    {
      select: ['id', 'starts_at', 'label', 'stages'],
      order: { starts_at: 'ASC' },
      take: 1,
    },
  );
  if (!row) return null;
  const raw = (row.stages ?? []) as unknown as {
    stage_number: number;
    threshold_myr: number;
    rank_rewards: ChallengeRankReward[];
  }[];
  const stages = raw
    .map((s) => ({
      stageNumber: Number(s.stage_number),
      thresholdMyr: Number(s.threshold_myr),
      rankRewards: (s.rank_rewards ?? [])
        .slice()
        .sort((a, b) => a.rank - b.rank)
        .map((r) => ({
          rank: r.rank,
          cardId: r.card_id ?? null,
          credits: Number(r.credits),
        })),
    }))
    .sort((a, b) => a.stageNumber - b.stageNumber);
  const ids = [
    ...new Set(
      stages.flatMap((s) =>
        s.rankRewards
          .map((r) => r.cardId)
          .filter((id): id is string => Boolean(id)),
      ),
    ),
  ];
  const rows = ids.length
    ? await packs.listCards(
        { id: ids },
        { select: ['id', 'name', 'image', 'slab_image'], take: ids.length },
      )
    : [];
  return {
    startsAt: new Date(row.starts_at),
    label: row.label ?? null,
    stages,
    cards: Object.fromEntries(
      rows.map((c) => [c.id, { name: c.name, image: c.slab_image ?? c.image }]),
    ),
  };
}
