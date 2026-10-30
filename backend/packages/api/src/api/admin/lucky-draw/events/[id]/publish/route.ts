import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { reqReason } from '../../../../rewards-settings/validate';

// POST /admin/lucky-draw/events/:id/publish — commit the event's seed hash and
// take a draft live under the one-winner rules. An overlap with another event is
// answered here, because Medusa swaps a CONFLICT's message for a generic one and
// the operator needs the name it clashes with.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  try {
    await packs.publishLuckyDrawEvent({
      id,
      adminId: req.auth_context.actor_id,
      reason: reqReason(req.body),
    });
  } catch (err) {
    if (err instanceof MedusaError && err.type === MedusaError.Types.CONFLICT) {
      res.status(409).json({ type: 'conflict', message: err.message });
      return;
    }
    throw err;
  }
  res.json({ id, status: 'published' });
}
