import {
  AuthenticatedMedusaRequest,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { updateCardWorkflow } from '../../../../workflows/update-card';
import { deleteCardWorkflow } from '../../../../workflows/delete-card';
import { coerceUpdateCardBody } from '../validate';
import { toAdminCardDto } from '../../../../modules/packs/admin-card';
import { resolveFxRate } from '../../../../modules/packs/pricing';

// GET /admin/cards/:handle — load one card for the edit form.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const { handle } = req.params;

  const [[card], fxRate] = await Promise.all([
    packs.listCards({ handle }, { take: 1 }),
    resolveFxRate(packs),
  ]);
  if (!card) {
    res.status(404).json({ message: `Card '${handle}' not found` });
    return;
  }

  res.json({ card: { ...toAdminCardDto(card, fxRate), id: card.id } });
}

// POST /admin/cards/:handle — update a card (+ re-sync its Product). `handle` is
// immutable: it comes from the path, never the body (it keys PackOdds/Pull/Product).
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { handle } = req.params;
  const input = coerceUpdateCardBody(
    (req.body ?? {}) as Record<string, unknown>,
    handle,
  );

  const { result } = await updateCardWorkflow(req.scope).run({ input });
  res.json({ card: result });
}

// DELETE /admin/cards/:handle — unregister a card from the gacha system (card +
// PackOdds membership). The inventory Product and Pull history are KEPT.
export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { handle } = req.params;
  await deleteCardWorkflow(req.scope).run({
    input: { handle, admin_id: req.auth_context.actor_id },
  });
  res.json({ deleted: true, handle });
}
