import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { reqReason } from '../../rewards-settings/validate';

// DELETE /admin/announcements/:id — soft delete, audited. The reason rides in
// the JSON body (same as DELETE /store/credits/withdraw/accounts' id).
export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const reason = reqReason(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.deleteAnnouncement({
    id: req.params.id,
    adminId: req.auth_context.actor_id,
    reason,
  });
  res.json({ id: req.params.id, deleted: true });
}
