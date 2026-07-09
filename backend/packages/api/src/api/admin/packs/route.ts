import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import PacksModuleService from "../../../modules/packs/service";
import { PACKS_MODULE } from "../../../modules/packs";
import { createPackWorkflow } from "../../../workflows/create-pack";
import { coercePackBody } from "./validate";
import { clearPackListCache } from "../../store/packs/route";

// GET /admin/packs — the pack selector list for the win-rate editor. An admin
// route, so it is auto-protected by Medusa's admin auth (session/bearer); no
// custom middleware needed. Returns every pack (active + draft) ordered by
// (category, rank) to mirror the storefront grouping.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packsModuleService: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  const packs = await packsModuleService.listPacks({}, { take: 1000 });
  const sorted = [...packs].sort((a, b) =>
    a.category === b.category
      ? a.rank - b.rank
      : a.category.localeCompare(b.category)
  );

  res.json({
    packs: sorted.map((p) => ({
      slug: p.slug,
      title: p.title,
      category: p.category,
      status: p.status,
      rank: p.rank,
      price: p.price,
      image: p.image,
      buyback_percent: p.buyback_percent,
      boost: p.boost,
      published_odds: p.published_odds ?? null,
    })),
  });
}

// POST /admin/packs — create a pack listing. A new pack starts with an empty
// prize pool; cards are assigned via the membership editor.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const input = coercePackBody(body, slug);

  const { result } = await createPackWorkflow(req.scope).run({ input });
  // A pack can be created directly as `active`, so bust the storefront list
  // cache to reflect it now instead of ≤30s later. (Detail has nothing to bust
  // yet — a new pack's pool is empty.)
  clearPackListCache();
  res.status(201).json({ pack: result });
}
