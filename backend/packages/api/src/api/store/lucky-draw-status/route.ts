import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { luckyDrawLatestGateAt, luckyDrawLive } from '../lucky-draw/view';

// GET /store/lucky-draw-status — { live, latest_gate_at }: is a Lucky Draw on,
// and when did the newest running gate go live (the Draw tab's dot)? Public,
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
  });
}
