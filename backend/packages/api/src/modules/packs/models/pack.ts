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
  // USD price as a DECIMAL (e.g. 4.99), never cents. bigNumber maps to a numeric
  // column (+ raw_price jsonb sidecar) like every other money field here
  // (card.market_value, pull.buyback_amount, credit_transaction.amount).
  // model.number() mapped to integer and truncated any cents.
  price: model.bigNumber(),
  image: model.text(),
  boost: model.boolean().default(false),
  // buyback_percent — the INSTANT sell-back rate (% of current FMV), applied
  // when the customer sells on the spot at the reveal (within the instant
  // window — see modules/packs/buyback-rate.ts). Also the storefront badge
  // (default 90 = the flat rate; premium Black/Diamond tiers are 92). Sells
  // from the vault/inventory always pay the FLAT rate — no per-pack vault rate.
  // in_stock=false renders a greyed "Out of Stock" tile on /claw.
  buyback_percent: model.number().default(90),
  in_stock: model.boolean().default(true),
  rank: model.number().default(0),
  status: model.enum(["active", "draft"]).default("active"),
  // PUBLISHED odds — the PUBLIC display shown to players ({ overall, tiers }
  // percentages, admin-authored). Pure display data: completely decoupled from
  // the secret per-card PackOdds weights that drive the actual draw. Null =
  // not set (the storefront hides the odds panel).
  published_odds: model.json().nullable(),
  // reward_box pool controls — A1
  pool_enabled: model.boolean().default(false),
  draws_per_day: model.number().default(0),
});

export default Pack;
