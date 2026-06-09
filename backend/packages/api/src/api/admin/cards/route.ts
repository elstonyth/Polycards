import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import PacksModuleService from "../../../modules/packs/service";
import { PACKS_MODULE } from "../../../modules/packs";
import { createCardWorkflow } from "../../../workflows/create-card";
import { coerceCardBody } from "./validate";

// GET /admin/cards — the catalog list for the admin Gacha Cards page (auto-
// protected by Medusa admin auth). Returns every card, alphabetical by name.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const cards = await packs.listCards({}, { take: 1000 });
  const sorted = [...cards].sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    cards: sorted.map((c) => ({
      handle: c.handle,
      name: c.name,
      set: c.set,
      grader: c.grader,
      grade: c.grade,
      rarity: c.rarity,
      market_value: Number(c.market_value),
      image: c.image,
      // Raw stored price: null means "use FMV" — the form preserves that sentinel.
      price: c.price === null ? null : Number(c.price),
      for_sale: c.for_sale,
    })),
  });
}

// POST /admin/cards — create a card (+ mirrored marketplace Product). Validation
// (handle format, rarity enum, numeric fields) throws MedusaError, which Medusa
// maps to the right HTTP status; handle/uniqueness is enforced in the workflow.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  const input = coerceCardBody(body, handle);

  const { result } = await createCardWorkflow(req.scope).run({ input });
  res.status(201).json({ card: result });
}
