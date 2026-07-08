import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import PacksModuleService from "../../../modules/packs/service";
import { PACKS_MODULE } from "../../../modules/packs";

// GET /store/packs — the gacha pack catalog for /claw and the home "Open Packs"
// tiles. A plain Medusa store route (publishable-key scoped, but NOT subject to
// Mercur's seller-visibility product middleware), so the house-seller machinery
// the marketplace needs does not apply here. Returns active packs ordered by
// (category, rank); the storefront groups them and attaches presentational
// category labels/icons from local assets.
// ponytail: per-process 30s cache — mirrors packCache in [slug]/route.ts and the
// leaderboard's boardCache. /store/packs is a fixed public query (no params),
// identical for every viewer, fetched on every anonymous (force-dynamic) home
// view via getPackCategories; this collapses the multi-row catalog query to one
// compute per 30s window. A pack going active/inactive or a price/stock edit
// lags ≤30s — display-only (the purchase path re-checks live state). Upgrade to
// Redis only if we ever run >1 instance.
const CACHE_TTL_MS = 30_000;
const LIST_KEY = 'list';
const listCache = new Map<string, { expires: number; body: unknown }>();

/** Test seam: module state outlives a test's fixtures — one jest process is one
 *  module instance, so a prior test's catalog would be served to the next. */
export function clearPackListCache(): void {
  listCache.clear();
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const cached = listCache.get(LIST_KEY);
  if (cached && cached.expires > Date.now()) {
    res.json(cached.body);
    return;
  }

  const packsModuleService: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  const packs = await packsModuleService.listPacks(
    // reward_box packs are internal draw pools — excluded from the public catalog (B2).
    { status: "active", category: { $ne: "reward_box" } } as Parameters<typeof packsModuleService.listPacks>[0],
    // Explicit take so a framework default can't silently cap the catalog.
    { order: { category: "ASC", rank: "ASC" }, take: 500 }
  );

  // Explicit public shape — `price` is bigNumber now, so a raw spread would
  // leak the internal `raw_price` jsonb sidecar (and id/timestamps) into a
  // public payload. `price` serializes as a JSON number (RM — all pack
  // prices and ledger money are Ringgit).
  const body = {
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
  };
  listCache.set(LIST_KEY, { expires: Date.now() + CACHE_TTL_MS, body });
  res.json(body);
}
