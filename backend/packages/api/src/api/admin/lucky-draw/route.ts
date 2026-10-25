import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';

// GET /admin/lucky-draw — every event with its prizes' hash, entry totals,
// value and (once drawn) result. An undrawn prize's seed is never in here.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json({ events: await packs.adminLuckyDrawOverview() });
}
