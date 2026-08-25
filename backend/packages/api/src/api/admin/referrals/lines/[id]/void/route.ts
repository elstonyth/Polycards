import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { reqReason } from '../../../../rewards-settings/validate';

// POST /admin/referrals/lines/:id/void { reason } — pull one payable line out
// of a run before its money moves. Audited in the service.
export async function POST(
  req: AuthenticatedMedusaRequest<{ reason?: unknown }>,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.voidSettlementLine({
    lineId: req.params.id,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json({ ok: true });
}
