import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { reqReason } from '../../../../rewards-settings/validate';

// POST /admin/lucky-draw/prizes/:id/cancel — withdraw an undrawn prize and
// refund every entrant's tickets on it, in one transaction.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { refunded } = await packs.cancelLuckyDrawPrize({
    id: req.params.id,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json({ refunded });
}
