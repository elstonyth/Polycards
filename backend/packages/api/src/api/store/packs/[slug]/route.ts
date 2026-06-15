import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import PacksModuleService from "../../../../modules/packs/service";
import { PACKS_MODULE } from "../../../../modules/packs";

// GET /store/packs/:slug — one active pack plus its prize pool (each odds row
// joined to the referenced Card), behind /claw/[slug]'s Top Hits. A plain Medusa
// store route (publishable-key scoped, NOT subject to Mercur's seller-visibility
// product middleware), so no house-seller link is needed. 404 when the slug is
// unknown or inactive. The join is in-module by stable business keys (Pack.slug,
// Card.handle).
//
// 🔒 SECRET ODDS (Phase 6): the per-card `weight` is the real, admin-tuned win
// rate and is DELIBERATELY OMITTED from this public response — it must never
// reach the customer (visible in the network tab under the publishable key).
// Customers see a separate, static published-odds display. Only non-secret card
// display fields (incl. market_value, which drives Top Hits) are exposed here.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packsModuleService: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const { slug } = req.params;

  const [pack] = await packsModuleService.listPacks(
    { slug, status: "active" },
    { take: 1 }
  );
  if (!pack) {
    res.status(404).json({ message: `Pack '${slug}' not found` });
    return;
  }

  const odds = await packsModuleService.listPackOdds(
    { pack_id: slug },
    // Explicit take so a framework default can't silently cap the prize pool.
    { take: 1000 }
  );

  const cardHandles = odds.map((o) => o.card_id);
  const cards = cardHandles.length
    ? await packsModuleService.listCards(
        { handle: cardHandles },
        { take: cardHandles.length }
      )
    : [];
  const cardByHandle = new Map(cards.map((c) => [c.handle, c]));

  // Join each odds row to its card; drop orphaned odds whose card is missing.
  // rarity comes from the odds row — the card's tier IN THIS PACK.
  const entries = odds
    .map((o) => {
      const card = cardByHandle.get(o.card_id);
      if (!card) return null;
      return {
        handle: card.handle,
        name: card.name,
        set: card.set,
        grader: card.grader,
        grade: card.grade,
        rarity: o.rarity,
        // market_value is a BigNumber (numeric column) — normalize to a JSON
        // number; it's a USD decimal, never cents.
        market_value: Number(card.market_value),
        image: card.image,
        // NOTE: o.weight (the secret win rate) is intentionally NOT included.
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  // Explicit public shape — `price` is bigNumber now, so a raw `pack` spread
  // would leak the internal `raw_price` jsonb sidecar into a public payload.
  res.json({
    pack: {
      slug: pack.slug,
      title: pack.title,
      category: pack.category,
      price: pack.price,
      image: pack.image,
      boost: pack.boost,
      buyback_percent: pack.buyback_percent,
      in_stock: pack.in_stock,
      rank: pack.rank,
      status: pack.status,
    },
    odds: entries,
  });
}
