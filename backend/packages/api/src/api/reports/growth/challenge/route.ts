import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  payoutByRank,
  unlockedStages,
} from '../../../../modules/packs/challenge-settle';
import { buildChallengeView } from '../../../store/challenge/build';
import { nextQueuedChallenge } from './queued';

const round2 = (x: number) => Math.round(x * 100) / 100;

// GET /reports/growth/challenge: the RUNNING Weekly Pulled Value Challenge
// exactly as the public Ranks page shows it (the same builder), plus what a
// post needs: the challenge week's own bounds, which stages are unlocked and
// how far off the next one is, and what the top 10 would get if the week
// ended now. No player ids and no player groups.
//
// ?week=next serves the next edition waiting in the admin queue instead
// (challenge_schedule): its start, label, thresholds and prizes.
//
// No past weeks, on purpose: an ended week recomputed live would use today's
// FX rate and whatever prize ladder was promoted after settlement, so it could
// announce prizes nobody was paid. What a past week actually paid lives in
// the settlement snapshot (/admin/challenge/winners, via the admin proxy).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const which = req.query.week ?? 'current';
  if (which !== 'current' && which !== 'next') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'week must be current (the running week) or next (the next one queued). Past weeks: /admin/challenge/winners.',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  if (which === 'next') {
    const queued = await nextQueuedChallenge(packs);
    if (!queued) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        'No challenge is waiting in the admin queue.',
      );
    }
    const settings = await packs.challengeSettings();
    res.json({
      currency: 'MYR',
      queued: true,
      starts_at: queued.startsAt.toISOString(),
      timezone: settings.timezone,
      label: queued.label,
      stages: queued.stages.map((s) => ({
        stage: s.stageNumber,
        threshold_myr: s.thresholdMyr,
        prizes: s.rankRewards.map((r) => ({
          rank: r.rank,
          card: r.cardId
            ? (queued.cards[r.cardId]?.name ?? 'a prize card')
            : null,
          card_image: r.cardId ? (queued.cards[r.cardId]?.image ?? null) : null,
          credits: r.credits,
        })),
      })),
      note: 'The next challenge in the admin queue. It takes over at starts_at; until then the running week stands. Nothing is unlocked yet: the pool starts at 0 when it begins, and each stage pays its prizes once the pool reaches its threshold, adding up across stages as the running week does.',
    });
    return;
  }
  const { body, hiddenAboveCut, week } = await buildChallengeView(req.scope);
  const bounds = await packs.challengeWeekBounds(week);
  const pool = body.progress.pooledMyr;
  const cardName = (id: string | null) =>
    id ? (body.cards[id]?.name ?? 'a prize card') : null;
  // The official art the site shows (graded slab preferred), so a post can
  // use the real card instead of an AI redraw.
  const cardImage = (id: string | null) =>
    id ? (body.cards[id]?.image ?? null) : null;

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
      cards: p.cardIds.map((id) => ({
        name: cardName(id),
        image: cardImage(id),
      })),
    }));

  res.json({
    currency: 'MYR',
    week: {
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
        card_image: cardImage(r.cardId),
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
