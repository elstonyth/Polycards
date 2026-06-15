import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import PacksModuleService from "../../../../modules/packs/service";
import { PACKS_MODULE } from "../../../../modules/packs";
import { updateCardWorkflow } from "../../../../workflows/update-card";
import { deleteCardWorkflow } from "../../../../workflows/delete-card";
import { coerceUpdateCardBody } from "../validate";
import { toMoney } from "../../../../modules/packs/money";

// GET /admin/cards/:handle — load one card for the edit form.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const { handle } = req.params;

  const [card] = await packs.listCards({ handle }, { take: 1 });
  if (!card) {
    res.status(404).json({ message: `Card '${handle}' not found` });
    return;
  }

  res.json({
    card: {
      handle: card.handle,
      name: card.name,
      set: card.set,
      grader: card.grader,
      grade: card.grade,
      market_value: toMoney(card.market_value),
      image: card.image,
      // Raw stored price: null means "use FMV" — the form preserves that sentinel.
      price: card.price === null ? null : toMoney(card.price),
      for_sale: card.for_sale,
    },
  });
}

// POST /admin/cards/:handle — update a card (+ re-sync its Product). `handle` is
// immutable: it comes from the path, never the body (it keys PackOdds/Pull/Product).
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { handle } = req.params;
  const input = coerceUpdateCardBody(
    (req.body ?? {}) as Record<string, unknown>,
    handle
  );

  const { result } = await updateCardWorkflow(req.scope).run({ input });
  res.json({ card: result });
}

// DELETE /admin/cards/:handle — unregister a card from the gacha system (card +
// PackOdds membership). The inventory Product and Pull history are KEPT.
export async function DELETE(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { handle } = req.params;
  await deleteCardWorkflow(req.scope).run({ input: { handle } });
  res.json({ deleted: true, handle });
}
