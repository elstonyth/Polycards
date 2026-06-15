import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import PacksModuleService from "../../../modules/packs/service";
import { PACKS_MODULE } from "../../../modules/packs";
import { createCardWorkflow } from "../../../workflows/create-card";
import { getCardStockByHandle } from "../../../modules/packs/card-stock";
import { coerceRegisterCardBody } from "./validate";
import { toMoney } from "../../../modules/packs/money";

// GET /admin/cards — the catalog list for the admin Gacha Cards page (auto-
// protected by Medusa admin auth). Returns every card, alphabetical by name.
// `stock` = available physical units (null = untracked/infinite); display-only,
// 0-stock cards stay everywhere (buyback fulfills them).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const cards = await packs.listCards({}, { take: 1000 });
  const sorted = [...cards].sort((a, b) => a.name.localeCompare(b.name));
  const stockByHandle = await getCardStockByHandle(
    req.scope,
    sorted.map((c) => c.handle)
  );

  res.json({
    cards: sorted.map((c) => ({
      handle: c.handle,
      name: c.name,
      set: c.set,
      grader: c.grader,
      grade: c.grade,
      market_value: toMoney(c.market_value),
      image: c.image,
      // Raw stored price: null means "use FMV" — the form preserves that sentinel.
      price: c.price === null ? null : toMoney(c.price),
      for_sale: c.for_sale,
      stock: stockByHandle.get(c.handle) ?? null,
    })),
  });
}

// POST /admin/cards — register an EXISTING inventory product as a gacha card
// (inventory-first: the item must be in the catalog already; body carries only
// product_id + the gacha facts). Uniqueness is enforced in the workflow.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const input = coerceRegisterCardBody((req.body ?? {}) as Record<string, unknown>);

  const { result } = await createCardWorkflow(req.scope).run({ input });
  res.status(201).json({ card: result });
}
