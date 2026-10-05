import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { posterWeekLabel } from '../../../../modules/packs/challenge-poster';
import {
  renderResultsPoster,
  resultsHeadline,
} from '../../../../modules/packs/challenge-results-poster';
import { latestChallengeResults } from '../challenge-results/results';

// GET /reports/growth/challenge-results-poster?part=top|rest: the most
// recently settled Weekly Challenge week as two 1080x1350 posting images
// (challenge-results-poster.ts): part top (default), the top 3 with every
// prize card they won, what they pulled and won; part rest, ranks 4-10. x-poster-week is the week's start; x-poster-missing-art
// names podium ranks whose card shows as a placeholder; x-poster-note says
// in plain words when a disabled winner was left out.
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
      })),
      list: results.winners
        .filter((w) => w.rank > 3 && w.rank <= 10)
        .map((w) => ({
          rank: w.rank,
          name: w.name,
          pulledMyr: w.pulledMyr,
          prizeMyr: w.prizeMyr,
        })),
      siteHost: 'polycards.gg/leaderboard',
    },
    new Map(top.map((w) => [w.rank, hand(w).map((c) => c.image)])),
    part,
  );
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('x-poster-week', results.weekStart.toISOString());
  res.setHeader('x-poster-part', part);
  if (missing.length) res.setHeader('x-poster-missing-art', missing.join(','));
  if (results.hidden) {
    res.setHeader(
      'x-poster-note',
      `${results.hidden} winner${results.hidden === 1 ? ' is' : 's are'} left off: their account is disabled, so they are hidden on every public surface. The others keep the rank they were paid.`,
    );
  }
  res.status(200).send(jpeg);
}
