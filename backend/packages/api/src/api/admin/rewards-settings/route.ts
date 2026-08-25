import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { validateRewardsPatch } from '../../../modules/packs/rewards-settings-validate';
import { reqReason } from './validate';

// GET /admin/rewards-settings — current reward config.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.rewardsSettings());
}

// POST /admin/rewards-settings — clamped, audited edit.
// admin_id is derived from the verified auth_context (NEVER from the body).
// Admin routes are framework-auto-protected — no authenticate() middleware needed.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const adminId = req.auth_context.actor_id;
  const reason = reqReason(req.body);
  const patch = validateRewardsPatch(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.editRewardsSettings({ patch, adminId, reason }));
}
