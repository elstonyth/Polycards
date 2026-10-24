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
// saveLuckyDrawEvent. A create may carry its prize pool in `prizes`:
// createLuckyDrawEventWithPrizes writes the event and every prize in one
// transaction, or nothing. Either way the event stays a draft.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id, prizes, ...event } = parseLuckyDrawEvent(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const write = {
    ...event,
    adminId: req.auth_context.actor_id,
    reason: reqReason(req.body),
  };
  if (id) {
    await packs.saveLuckyDrawEvent({ ...write, id });
    res.json({ id, prize_ids: [] });
    return;
  }
  const created = await packs.createLuckyDrawEventWithPrizes({
    ...write,
    prizes: prizes ?? [],
  });
  res.json({ id: created.id, prize_ids: created.prizeIds });
}
