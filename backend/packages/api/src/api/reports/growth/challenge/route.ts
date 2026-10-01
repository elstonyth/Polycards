import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  payoutByRank,
  unlockedStages,
} from '../../../../modules/packs/challenge-settle';
import { buildChallengeView } from '../../../store/challenge/build';

const WEEKS: Record<string, number> = { current: 0, last: 1 };
const round2 = (x: number) => Math.round(x * 100) / 100;

// GET /reports/growth/challenge?week=current|last: the Weekly Pulled Value
// Challenge exactly as the public Ranks page shows it (the same builder), plus
// what a post needs: the challenge week's own bounds, which stages are
// unlocked and how far off the next one is, and what the top 10 would get if
// the week ended now. No player ids and no player groups.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const which = req.query.week ?? 'current';
  if (typeof which !== 'string' || !Object.hasOwn(WEEKS, which)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "week must be 'current' or 'last'.",
    );
  }
  const { body, hiddenAboveCut, week } = await buildChallengeView(
    req.scope,
    WEEKS[which],
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const bounds = await packs.challengeWeekBounds(week);
  const pool = body.progress.pooledMyr;
  const cardName = (id: string | null) =>
    id ? (body.cards[id]?.name ?? 'a prize card') : null;

  // Cumulative prizes, computed the way settlement pays them.
  const settle = body.stages.map((s) => ({
    stage_number: s.stageNumber,
    threshold_myr: s.thresholdMyr,
    rank_rewards: s.rankRewards.map((r) => ({
      rank: r.rank,
      card_id: r.cardId,
      credits: r.credits,
    })),
  }));
  const prizes = [...payoutByRank(unlockedStages(settle, pool)).values()]
    .sort((a, b) => a.rank - b.rank)
    .map((p) => ({
      rank: p.rank,
      credits: p.credits,
      cards: p.cardIds.map(cardName),
    }));

  res.json({
    currency: 'MYR',
    week: {
      which,
      timezone: body.settings.timezone,
      start: bounds.startUtc.toISOString(),
      end: bounds.endUtc.toISOString(),
    },
    active: body.active,
    pool_myr: pool,
    stages: body.stages.map((s) => ({
      stage: s.stageNumber,
      threshold_myr: s.thresholdMyr,
      unlocked: pool >= s.thresholdMyr,
      remaining_myr: Math.max(0, round2(s.thresholdMyr - pool)),
      prizes: s.rankRewards.map((r) => ({
        rank: r.rank,
        card: cardName(r.cardId),
        credits: r.credits,
      })),
    })),
    prizes_if_week_ended_now: prizes,
    standings: body.top.map((t) => ({
      rank: t.rank,
      name: t.name,
      handle: t.handle,
      pulls: t.pulls,
      pulled_value_myr: t.volumeMyr,
    })),
    hidden_players_above_cut: hiddenAboveCut,
    note: 'The same board as the public Ranks page. Pulled value is each draw value at the live exchange rate, so it can move without new pulls. Until the week ends, the top player is the current leader, not the winner. If hidden_players_above_cut is above 0, prizes are paid by original rank, so do not pair displayed ranks with prizes.',
  });
}
