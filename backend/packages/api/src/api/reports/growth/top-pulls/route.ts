import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { malaysiaDay, topPullsLimit } from './day';
import { loadTopPulls, publicTopPull } from './hits';

// GET /reports/growth/top-pulls?day&limit: one Malaysia day's most valuable
// paid pulls (default yesterday, top 10), ranked by the pulled value the
// Ranks page counts, with the card, its tier, the pack and the player's
// public name. Public data only: no customer id or contact details.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = malaysiaDay(req.query.day);
  const limit = topPullsLimit(req.query.limit);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const pulls = await loadTopPulls(req, packs, window, limit);
  res.json({
    day: window.day,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    pulls: pulls.map(publicTopPull),
    note: "Paid pack pulls only (free welcome packs and prize draws are not counted), ranked by pulled value: the card value at the moment it was pulled, in RM at today's exchange rate, as the Ranks page counts it. Players whose accounts are disabled are left out. Player names are the public names the site and the Telegram channel show.",
  });
}
