import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { posterWeekLabel } from '../../../../modules/packs/challenge-poster';
import {
  renderResultsPoster,
  resultsHeadline,
} from '../../../../modules/packs/challenge-results-poster';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { appliedChallengeAt } from '../challenge/queued';
import {
  latestChallengeResults,
  lockedStageRewards,
} from '../challenge-results/results';

// GET /reports/growth/challenge-results-poster?part=top|rest: the most
// recently settled Weekly Challenge week as two 1080x1350 posting images
// (challenge-results-poster.ts): part top (default), the top 3 with every
// prize card they won, what they pulled and won; part rest, ranks 4-10. The
// first stage the week did not unlock shows too, dimmed under a lock, with
// what it would have added. x-poster-week is the week's start;
// x-poster-missing-art names podium ranks whose card shows as a placeholder;
// x-poster-note says in plain words when a disabled winner was left out and
// which stage is drawn locked.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const part = req.query.part ?? 'top';
  if (part !== 'top' && part !== 'rest') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'part must be top (the top 3 with their cards) or rest (ranks 4-10).',
    );
  }
  const results = await latestChallengeResults(req.scope);
  if (!results) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'No Weekly Challenge week has been settled yet.',
    );
  }
  const top = results.winners.filter((w) => w.rank <= 3);
  // Every card each winner received, most valuable first, once per pull
  // minted (two stages can award one card twice).
  const hand = (w: (typeof top)[number]) =>
    w.cards.flatMap((c) => Array.from({ length: c.qty }, () => c));
  // The first stage the week did not unlock, from the ladder it ran on: what
  // it would have added, drawn dimmed under a lock, so the post shows the
  // stage to reach. Left off when the week's ladder is not on record.
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const ladder = await appliedChallengeAt(packs, results.weekStart);
  const next = ladder?.stages.find(
    (s) => !results.unlockedStages.includes(s.stageNumber),
  );
  const lockedByRank = next
    ? await lockedStageRewards(packs, next)
    : new Map<number, never>();
  const lockedOf = (rank: number) => {
    const l = lockedByRank.get(rank);
    return (
      l && {
        stage: l.stage,
        prizeMyr: l.prizeMyr,
        cards: l.hand.map((c) => c.title),
      }
    );
  };
  const { jpeg, missing } = await renderResultsPoster(
    {
      weekLabel: posterWeekLabel(
        results.weekStart,
        results.weekEnd,
        results.timezone,
      ),
      headline: resultsHeadline(results.poolMyr, results.unlockedStages),
      podium: top.map((w) => ({
        rank: w.rank,
        name: w.name,
        pulledMyr: w.pulledMyr,
        prizeMyr: w.prizeMyr,
        credits: w.credits,
        cards: hand(w).map((c) => c.title),
        locked: lockedOf(w.rank),
      })),
      list: results.winners
        .filter((w) => w.rank > 3 && w.rank <= 10)
        .map((w) => ({
          rank: w.rank,
          name: w.name,
          pulledMyr: w.pulledMyr,
          prizeMyr: w.prizeMyr,
          locked: lockedOf(w.rank),
        })),
      siteHost: 'polycards.gg/leaderboard',
    },
    new Map(
      top.map((w) => [
        w.rank,
        [
          ...hand(w).map((c) => c.image),
          ...(lockedByRank.get(w.rank)?.hand ?? []).map((c) => c.image),
        ],
      ]),
    ),
    part,
  );
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('x-poster-week', results.weekStart.toISOString());
  res.setHeader('x-poster-part', part);
  if (missing.length) res.setHeader('x-poster-missing-art', missing.join(','));
  const notes = [
    results.hidden
      ? `${results.hidden} winner${results.hidden === 1 ? ' is' : 's are'} left off: their account is disabled, so they are hidden on every public surface. The others keep the rank they were paid.`
      : '',
    next
      ? `Stage ${next.stageNumber} was not unlocked that week: its rewards are drawn dimmed under a lock, with a "STAGE ${next.stageNumber} +RM" line for what each rank would have added (cards at today's value). Nobody was paid them.`
      : '',
  ].filter(Boolean);
  if (notes.length) res.setHeader('x-poster-note', notes.join(' '));
  res.status(200).send(jpeg);
}
