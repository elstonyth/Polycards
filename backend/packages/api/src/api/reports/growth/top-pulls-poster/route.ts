import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { LADDER_MAX_TILES } from '../../../../modules/packs/ladder-poster';
import { renderTopPullsPoster } from '../../../../modules/packs/top-pulls-poster';
import { malaysiaDay, topPullsLimit } from '../top-pulls/day';
import { loadTopPulls } from '../top-pulls/hits';

// GET /reports/growth/top-pulls-poster?day&limit: one Malaysia day's top paid
// pulls (default yesterday, top 10) as a posting poster in the site design
// (modules/packs/top-pulls-poster.ts): each pull's slab, rank, public name,
// card and pulled value. Nothing on it is typed in. x-poster-ranks lists the
// ranks drawn; x-poster-missing-art the ranks whose slab could not be loaded.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = malaysiaDay(req.query.day);
  // A poster draws at most LADDER_MAX_TILES.
  const limit = Math.min(topPullsLimit(req.query.limit), LADDER_MAX_TILES);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const pulls = await loadTopPulls(req, packs, window, limit);
  if (!pulls.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `No paid pulls on ${window.day} (Malaysia time).`,
    );
  }
  const { jpeg, missing } = await renderTopPullsPoster(
    {
      dayLabel: window.label,
      pulls: pulls.map((p) => ({
        rank: p.rank,
        cardName: p.card.name,
        grade: p.card.grade,
        valueMyr: p.value_myr,
        player: p.player.name,
      })),
      siteHost: 'polycards.gg',
    },
    pulls.map((p) => p.card.slab_image ?? p.card.image),
  );
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('x-poster-ranks', pulls.map((p) => p.rank).join(','));
  if (missing.length) res.setHeader('x-poster-missing-art', missing.join(','));
  res.status(200).send(jpeg);
}
