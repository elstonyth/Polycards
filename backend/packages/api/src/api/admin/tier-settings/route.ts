import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { validateTierRanges } from '../../../modules/packs/tier-settings-validate';
import { reqReason } from '../rewards-settings/validate';

// GET /admin/tier-settings — the singleton or an empty map (never 404s). An
// empty `ranges` leaves the tier-defaults feature inert in the admin app.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.tierSettings());
}

// POST /admin/tier-settings — audited singleton replace. The whole `ranges`
// map is written each save (json columns MERGE on update, so a partial patch
// could never clear a tier — see editTierSettings).
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const adminId = req.auth_context.actor_id;
  const reason = reqReason(req.body);
  const ranges = validateTierRanges(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.editTierSettings({ ranges, adminId, reason }));
}
