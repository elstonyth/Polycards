import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import {
  luckyDrawLatestGateAt,
  luckyDrawLive,
  luckyDrawUpcoming,
} from '../lucky-draw/view';

// GET /store/lucky-draw-status — { live, latest_gate_at, upcoming }: is a Lucky
// Draw on, when did the newest running gate go live (the Draw tab's dot), and
// which gates are still to draw (the draw popup watches them)? Public,
// unlike /store/lucky-draw (customer-only): the Games sheet shows "Coming soon"
// to signed-out visitors too. From the shared cached page, so it says nothing
// about prizes or entrants.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json({
    live: await luckyDrawLive(req, packs),
    latest_gate_at: await luckyDrawLatestGateAt(req, packs),
    upcoming: await luckyDrawUpcoming(req, packs),
  });
}
