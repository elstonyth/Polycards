import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { luckyDrawLive } from '../lucky-draw/view';

// GET /store/lucky-draw-status — { live }: is a Lucky Draw on? Public, unlike
// /store/lucky-draw (customer-only): the Games sheet shows "Coming soon" to
// signed-out visitors too. A bare boolean from the shared cached page, so it
// says nothing about prizes or entrants.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json({ live: await luckyDrawLive(req, packs) });
}
