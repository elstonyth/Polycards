import { model } from "@medusajs/framework/utils";

// Pack — a gacha pack listing surfaced on /claw and the home "Open Packs" tiles.
//
// Phase 4 scope is the *catalog/listing* only: the fields here are exactly what
// the storefront needs to render a grouped pack grid. The gacha internals
// (PackOdds, Card, Pull) and the pack->product link used for checkout are
// deferred to Phase 5 (the open-pack workflow), where they are actually
// exercised — see docs/BUILD_PLAN.md.
//
// `slug` doubles as the /claw/<slug> route id (kept in sync with the
// storefront's packs-data.ts so /claw/[slug] keeps resolving until Phase 5
// wires the detail page to the backend). `category` is a stable key
// (pokemon | one-piece | basketball | baseball | football | soccer | yugioh |
// riftbound) that the storefront maps to presentational labels/icons.
export const Pack = model.define("pack", {
  id: model.id().primaryKey(),
  slug: model.text().unique(),
  title: model.text(),
  category: model.text(),
  price: model.number(),
  image: model.text(),
  boost: model.boolean().default(false),
  // Buyback percentage shown on the storefront boost badge (default 90; premium
  // Black/Diamond tiers are 92). in_stock=false renders a greyed "Out of Stock"
  // tile on /claw (e.g. the Trainer tier).
  buyback_percent: model.number().default(90),
  in_stock: model.boolean().default(true),
  rank: model.number().default(0),
  status: model.enum(["active", "draft"]).default("active"),
});

export default Pack;
