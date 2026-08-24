import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { reqReason } from '../../../../rewards-settings/validate';

// POST /admin/referrals/settlements/:id/void { reason } — cancel a whole
// DRAFT run before approval. Every pending line is voided; audited in the
// service.
export async function POST(
  req: AuthenticatedMedusaRequest<{ reason?: unknown }>,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.voidWeeklySettlement({
    settlementId: req.params.id,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json({ ok: true });
}
