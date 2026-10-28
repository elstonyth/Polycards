import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { reqReason } from '../../rewards-settings/validate';
import { parseLuckyDrawPrize } from '../validate';

// POST /admin/lucky-draw/prizes — create (no id) or edit (with id) a prize.
// Card existence, the credit range, the window rules and the published-event
// locks live in saveLuckyDrawPrize.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const input = parseLuckyDrawPrize(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { id } = await packs.saveLuckyDrawPrize({
    ...input,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json({ id });
}
