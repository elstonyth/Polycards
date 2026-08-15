import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import PacksModuleService from "../../../../modules/packs/service";
import { PACKS_MODULE } from "../../../../modules/packs";
import { updatePackWorkflow } from "../../../../workflows/update-pack";
import { normalizePublishedOdds } from "../../../../workflows/steps/create-pack";
import { deletePackWorkflow } from "../../../../workflows/delete-pack";
import { assertSingleActiveFreePack, coercePackBody } from "../validate";
import { FREE_WELCOME_CATEGORY } from "../../../../modules/packs/free-pack";
import { clearPackListCache } from "../../../store/packs/route";
import { clearPackDetailCache } from "../../../store/packs/[slug]/route";

// Bust the storefront's 30s read caches (list + detail) so an admin pack edit
// (price/status/stock/published-odds) shows IMMEDIATELY instead of ≤30s later.
// The caches keep read-perf; this only invalidates them on the rare write.
function bustStorefrontPackCaches(): void {
  clearPackListCache();
  clearPackDetailCache();
}

// GET /admin/packs/:slug — load one pack for the edit form.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const { slug } = req.params;

  const [pack] = await packs.listPacks({ slug }, { take: 1 });
  if (!pack) {
    res.status(404).json({ message: `Pack '${slug}' not found` });
    return;
  }

  res.json({
    pack: {
      slug: pack.slug,
      title: pack.title,
      category: pack.category,
      price: pack.price,
      image: pack.image,
      display_image: pack.display_image ?? null,
      buyback_percent: pack.buyback_percent,
      boost: pack.boost,
      rank: pack.rank,
      status: pack.status,
      // Normalized — see the packs list route; the edit form seeds its
      // inputs from these values.
      published_odds: normalizePublishedOdds(pack.published_odds),
    },
  });
}

// POST /admin/packs/:slug — update a pack. `slug` is immutable (it keys PackOdds
// and the /claw route), so it comes from the path, never the body.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { slug } = req.params;
  const input = coercePackBody((req.body ?? {}) as Record<string, unknown>, slug);

  // Only ONE free_welcome pack may be live. Re-saving the pack that IS the live
  // one passes (same slug); activating a second one 400s.
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  assertSingleActiveFreePack(
    input.category === FREE_WELCOME_CATEGORY
      ? ((await packs.getActiveFreePack())?.slug ?? null)
      : null,
    input,
  );

  const { result } = await updatePackWorkflow(req.scope).run({ input });
  bustStorefrontPackCaches();
  res.json({ pack: result });
}

// DELETE /admin/packs/:slug — delete a pack and its prize-pool membership
// (cards + Pull history kept).
export async function DELETE(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { slug } = req.params;
  await deletePackWorkflow(req.scope).run({ input: { slug } });
  bustStorefrontPackCaches();
  res.json({ deleted: true, slug });
}
