import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { MedusaError } from '@medusajs/framework/utils';

// POST /admin/pack-gifts/:id/revoke — take back one gift that has not been
// opened (spec 2026-10-07 §7). 409 "Already opened" / "Already revoked"
// otherwise; the conditional update cannot race an open that claimed it.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  try {
    res.json(
      await packs.revokePackGift({
        giftId: req.params.id,
        adminId: req.auth_context.actor_id,
      }),
    );
  } catch (err) {
    // Medusa's handler would replace a CONFLICT message with a generic one.
    if (
      err instanceof MedusaError &&
      err.type === MedusaError.Types.CONFLICT
    ) {
      res.status(409).json({ type: 'conflict', message: err.message });
      return;
    }
    throw err;
  }
}
