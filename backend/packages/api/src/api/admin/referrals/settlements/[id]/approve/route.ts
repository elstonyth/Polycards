import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';

// POST /admin/referrals/settlements/:id/approve — the human gate between
// Tuesday's draft and Wednesday's money. Audited in the service.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.approveWeeklySettlement({
    settlementId: req.params.id,
    adminId: req.auth_context.actor_id,
  });
  res.json({ ok: true });
}
