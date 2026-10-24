import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { reqReason } from '../../rewards-settings/validate';
import { parseLuckyDrawEvent } from '../validate';

// POST /admin/lucky-draw/events — create (no id) or edit (with id) an event.
// Validation, the draft/published edit rules and the audit row live in
// saveLuckyDrawEvent.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const input = parseLuckyDrawEvent(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { id } = await packs.saveLuckyDrawEvent({
    ...input,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  });
  res.json({ id });
}
