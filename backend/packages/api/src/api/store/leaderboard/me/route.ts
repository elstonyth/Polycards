import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';

// GET /store/leaderboard/me — the authenticated customer's OWN weekly pulled
// value, for the "how far off the board am I" line on /leaderboard.
//
// Why this is a separate route and not a field on GET /store/leaderboard: that
// route caches its whole body in a per-process Map keyed by period alone, and
// the storefront memoises it again under `leaderboard:<period>`. A per-customer
// field added there would be served to every other visitor for the rest of the
// 30s window. This route is authenticated and NEVER cached — the numbers are
// one indexed aggregate over one customer's pulls, not a board-wide scan.
//
// Reads the SAME figure the weekly board ranks by (challengeWeekVolumeFor
// shares the week anchor, the pulled-value expression and the source = 'pack'
// filter with challengeWeekTop), so the gap the storefront renders can never
// disagree with the row it is measured against.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerId = req.auth_context.actor_id;

  const s = await packs.challengeSettings();
  const { pulls, volumeMyr } = await packs.challengeWeekVolumeFor({
    timezone: s.timezone,
    resetDay: s.reset_day,
    resetHour: s.reset_hour,
    customerId,
  });

  // `pulls` ships alongside the money because volume alone cannot tell "ripped
  // nothing this week" apart from "ripped a card with no price on file" — both
  // read as 0. The storefront branches its copy on the count.
  res.json({ volume: volumeMyr, pulls });
}
