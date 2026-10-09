import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import { posterWeekLabel } from '../../../../modules/packs/challenge-poster';
import { renderResultsPoster } from '../../../../modules/packs/challenge-results-poster';
import {
  payoutByRank,
  unlockedStages,
} from '../../../../modules/packs/challenge-settle';
import type PacksModuleService from '../../../../modules/packs/service';
import { buildChallengeView } from '../../../store/challenge/build';
import {
  byValue,
  MISSING_PRIZE_CARD,
  type PrizeCard,
  prizeCardsById,
  prizeValue,
} from '../challenge-results/results';
import { standingsHeadline, weekEndsLabel } from './standings';

// GET /reports/growth/challenge-standings-poster?part=top|rest: who is
// leading the RUNNING Weekly Challenge, as two 1080x1350 posting images in the
// results posters' look (the Friday "who's leading" post): part top, the
// current top 3 with every card they would win if the week ended now; part
// rest, ranks 4-10. A rank's prize is every unlocked stage's reward for it,
// added up the way settlement pays (challenge-settle.ts), each card at
// today's value. The next stage, still locked, shows too: its cards dimmed
// under a lock and what it would add for each rank. Names and pulled values
// are the public Ranks page's (the same builder). x-poster-note says it is
// live and how far the next stage is.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const part = req.query.part ?? 'top';
  if (part !== 'top' && part !== 'rest') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'part must be top (the top 3 with the cards they would win) or rest (ranks 4-10).',
    );
  }
  const { body, hiddenAboveCut, week } = await buildChallengeView(req.scope);
  if (!body.active) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'The Weekly Pulled Value Challenge has no stages set up.',
    );
  }
  if (!body.top.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'Nobody has pulled in this challenge week yet: there are no leaders to show.',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const bounds = await packs.challengeWeekBounds(week);
  const pool = body.progress.pooledMyr;
  const settleStage = (s: (typeof body.stages)[number]) => ({
    stage_number: s.stageNumber,
    threshold_myr: s.thresholdMyr,
    rank_rewards: s.rankRewards.map((r) => ({
      rank: r.rank,
      card_id: r.cardId,
      credits: r.credits,
    })),
  });
  const byRank = payoutByRank(
    unlockedStages(body.stages.map(settleStage), pool),
  );
  // The next stage, still locked: what it would add, drawn dimmed under a
  // lock (the headline says what it still needs).
  const next = body.stages.find((s) => pool < s.thresholdMyr);
  const lockedByRank = payoutByRank(next ? [settleStage(next)] : []);
  const cardById = await prizeCardsById(
    packs,
    [...byRank.values(), ...lockedByRank.values()].flatMap((p) => p.cardIds),
  );
  // What a rank wins if the week ended now: one card per pull it would mint
  // (two stages can award one card twice), most valuable first.
  const prizeOf = (rank: number, payouts = byRank) => {
    const payout = payouts.get(rank);
    const qty = new Map<string, number>();
    for (const id of payout?.cardIds ?? []) qty.set(id, (qty.get(id) ?? 0) + 1);
    const cards: PrizeCard[] = byValue(
      [...qty].map(([id, n]) => ({
        ...(cardById.get(id) ?? MISSING_PRIZE_CARD),
        qty: n,
      })),
    );
    const credits = payout?.credits ?? 0;
    const hand = cards.flatMap((c) => Array.from({ length: c.qty }, () => c));
    return { credits, prizeMyr: prizeValue(credits, cards), hand };
  };
  const lockedOf = (rank: number) => {
    const prize = prizeOf(rank, lockedByRank);
    return next && (prize.credits > 0 || prize.hand.length)
      ? {
          stage: next.stageNumber,
          prizeMyr: prize.prizeMyr,
          hand: prize.hand,
        }
      : undefined;
  };
  const ends = weekEndsLabel(bounds.endUtc, body.settings.timezone);
  const podium = body.top
    .filter((t) => t.rank <= 3)
    .map((t) => ({
      standing: t,
      prize: prizeOf(t.rank),
      locked: lockedOf(t.rank),
    }));

  const { jpeg, missing } = await renderResultsPoster(
    {
      weekLabel: posterWeekLabel(
        bounds.startUtc,
        bounds.endUtc,
        body.settings.timezone,
      ),
      headline: standingsHeadline(pool, body.stages),
      podium: podium.map(({ standing, prize, locked }) => ({
        rank: standing.rank,
        name: standing.name,
        pulledMyr: standing.volumeMyr,
        prizeMyr: prize.prizeMyr,
        credits: prize.credits,
        cards: prize.hand.map((c) => c.title),
        locked: locked && {
          stage: locked.stage,
          prizeMyr: locked.prizeMyr,
          cards: locked.hand.map((c) => c.title),
        },
      })),
      list: body.top
        .filter((t) => t.rank > 3 && t.rank <= 10)
        .map((t) => {
          const locked = lockedOf(t.rank);
          return {
            rank: t.rank,
            name: t.name,
            pulledMyr: t.volumeMyr,
            prizeMyr: prizeOf(t.rank).prizeMyr,
            locked: locked && {
              stage: locked.stage,
              prizeMyr: locked.prizeMyr,
            },
          };
        }),
      siteHost: 'polycards.gg/leaderboard',
      title: 'WEEKLY CHALLENGE LEADERS',
      // Short like 'WON', so a half panel still fits what they pulled.
      wonLabel: 'WINS',
      footer: `LIVE STANDINGS · THE WEEK ENDS ${ends}`,
    },
    new Map(
      podium.map(({ standing, prize, locked }) => [
        standing.rank,
        [...prize.hand, ...(locked?.hand ?? [])].map((c) => c.image),
      ]),
    ),
    part,
  );
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('x-poster-part', part);
  res.setHeader('x-poster-week', bounds.startUtc.toISOString());
  if (missing.length) res.setHeader('x-poster-missing-art', missing.join(','));
  res.setHeader(
    'x-poster-note',
    [
      "Live standings as of now, not results: each player shows what they would win if the week ended now (every unlocked stage's reward for their rank, cards at today's value).",
      next
        ? `RM ${Math.ceil(next.thresholdMyr - pool).toLocaleString('en-MY')} more unlocks stage ${next.stageNumber}. Stage ${next.stageNumber} is still locked: its rewards are drawn dimmed under a lock, with a "STAGE ${next.stageNumber} +RM" line for what each rank would add; nobody wins them unless the pool gets there before the week ends.`
        : 'Every stage is unlocked.',
      `The week ends after ${ends}.`,
      hiddenAboveCut > 0
        ? `${hiddenAboveCut} disabled player${hiddenAboveCut === 1 ? ' is' : 's are'} hidden above the cut; prizes are paid by original rank, so the prizes shown may shift.`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
  res.status(200).send(jpeg);
}
