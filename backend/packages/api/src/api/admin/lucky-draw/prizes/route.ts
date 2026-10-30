import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { reqReason } from '../../rewards-settings/validate';
import { parseLuckyDrawPrize } from '../validate';

// POST /admin/lucky-draw/prizes — create (no id) or edit (with id) a prize.
// Card existence, the credit range, the window rules and the published-event
// locks live in saveLuckyDrawPrize. Adding a prize to a finished old-rule event
// can overlap a newer event: answered here, because Medusa swaps a CONFLICT's
// message for a generic one.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const input = parseLuckyDrawPrize(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  try {
    const { id } = await packs.saveLuckyDrawPrize({
      ...input,
      adminId: req.auth_context.actor_id,
      reason: reqReason(req.body),
    });
    res.json({ id });
  } catch (err) {
    if (err instanceof MedusaError && err.type === MedusaError.Types.CONFLICT) {
      res.status(409).json({ type: 'conflict', message: err.message });
      return;
    }
    throw err;
  }
}
