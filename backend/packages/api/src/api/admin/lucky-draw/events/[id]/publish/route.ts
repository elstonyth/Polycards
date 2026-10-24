import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { reqReason } from '../../../../rewards-settings/validate';

// POST /admin/lucky-draw/events/:id/publish — commit every prize's seed hash
// and take a draft event live.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.publishLuckyDrawEvent({
    id,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json({ id, status: 'published' });
}
