import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { posterWeekLabel } from '../../../../modules/packs/challenge-poster';
import { assetOrigin } from '../../../utils/image-fetch';
import { latestChallengeResults } from './results';

// A stored picture is often storefront-relative; the bot needs a full link.
const absolute = (url: string | null): string | null =>
  url?.startsWith('/') ? `${assetOrigin()}${url}` : url;

// GET /reports/growth/challenge-results: the most recently settled Weekly
// Challenge week as settlement paid it (results.ts): each winner's paid rank,
// public name, that week's pulled value, the cards and credits they received
// and what that is worth today. No customer ids or contact details.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const results = await latestChallengeResults(req.scope);
  if (!results) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'No Weekly Challenge week has been settled yet.',
    );
  }
  res.json({
    currency: 'MYR',
    week: {
      start: results.weekStart.toISOString(),
      end: results.weekEnd.toISOString(),
      timezone: results.timezone,
      label: posterWeekLabel(
        results.weekStart,
        results.weekEnd,
        results.timezone,
      ),
    },
    pool_myr: results.poolMyr,
    unlocked_stages: results.unlockedStages,
    winners: results.winners.map((w) => ({
      rank: w.rank,
      name: w.name,
      handle: w.handle,
      pulled_value_myr: w.pulledMyr,
      credits: w.credits,
      cards: w.cards.map((c) => ({
        name: c.name,
        image: absolute(c.image),
        qty: c.qty,
        value_myr: c.valueMyr,
      })),
      prize_value_myr: w.prizeMyr,
    })),
    hidden_winners: results.hidden,
    note: "The most recently settled week. Prizes are exactly what settlement paid (ranks are the paid ranks). pulled_value_myr is that week's pulled value at today's exchange rate; a card's value_myr is today's display market price (it moves with the market), and prize_value_myr is the credits plus the cards at today's value. If hidden_winners is above 0, those winners' accounts are disabled and they are left out, as on every public surface; the rest keep the rank they were paid. Names are public display names.",
  });
}
