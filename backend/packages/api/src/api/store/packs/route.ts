import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import PacksModuleService from "../../../modules/packs/service";
import { PACKS_MODULE } from "../../../modules/packs";

// GET /store/packs — the gacha pack catalog for /claw and the home "Open Packs"
// tiles. A plain Medusa store route (publishable-key scoped, but NOT subject to
// Mercur's seller-visibility product middleware), so the house-seller machinery
// the marketplace needs does not apply here. Returns active packs ordered by
// (category, rank); the storefront groups them and attaches presentational
// category labels/icons from local assets.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packsModuleService: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  const packs = await packsModuleService.listPacks(
    { status: "active" },
    // Explicit take so a framework default can't silently cap the catalog.
    { order: { category: "ASC", rank: "ASC" }, take: 500 }
  );

  // Explicit public shape — `price` is bigNumber now, so a raw spread would
  // leak the internal `raw_price` jsonb sidecar (and id/timestamps) into a
  // public payload. `price` serializes as a JSON number (whole-dollar USD).
  res.json({
    packs: packs.map((p) => ({
      slug: p.slug,
      title: p.title,
      category: p.category,
      price: p.price,
      image: p.image,
      boost: p.boost,
      buyback_percent: p.buyback_percent,
      in_stock: p.in_stock,
      rank: p.rank,
      status: p.status,
    })),
  });
}
