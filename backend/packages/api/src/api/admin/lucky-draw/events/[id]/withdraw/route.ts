import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { reqReason } from '../../../../rewards-settings/validate';

// POST /admin/lucky-draw/events/:id/withdraw — stop a one_winner event, until it
// has a result: cancels it and refunds every entrant, in one transaction.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { refunded } = await packs.withdrawLuckyDrawEvent({
    id: req.params.id,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json({ refunded });
}
