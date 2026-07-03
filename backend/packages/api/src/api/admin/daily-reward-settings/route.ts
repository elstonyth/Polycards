import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { validateDailyRewardPatch } from '../../../modules/packs/daily-reward-validate';
import { reqReason } from '../rewards-settings/validate';

// GET /admin/daily-reward-settings — current daily check-in config.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.dailyRewardSettings());
}

// POST /admin/daily-reward-settings — validated, audited edit (mirrors
// rewards-settings). admin_id derives from the verified auth_context, never
// the body; framework admin auth protects the route, adminActionRateLimit in
// middlewares.ts shares the admin money-mutation budget.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const adminId = req.auth_context.actor_id;
  const reason = reqReason(req.body);
  const patch = validateDailyRewardPatch(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.editDailyRewardSettings({ patch, adminId, reason }));
}
