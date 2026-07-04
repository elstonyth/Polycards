import { model } from '@medusajs/framework/utils';

// PackOdds — the gacha table: one row per (pack, card) with a relative weight.
// Pull chance = weight / Σ(weights in the pack). Admin-editable in Phase 6.
//
// References are stored by stable business keys (Pack.slug, Card.handle) rather
// than generated ids, so the seed needs no id round-trip and the store route
// joins them in-module (same-module JS join is fine; the cross-module-filter
// caveat in BUILD_PLAN only applies to linked modules).
//
// A2 — reward pool entries: card_id + rarity are NULLABLE so reward_box packs
// can hold prize entries (product/credit/nothing) alongside or instead of card
// entries. Legacy card rows keep kind=NULL (the cross-column CHECK allows it).
export const PackOdds = model
  .define('pack_odds', {
    id: model.id().primaryKey(),
    pack_id: model.text(), // = Pack.slug
    card_id: model.text().nullable(), // = Card.handle; NULL for reward entries
    // PER-PACK rarity: the same card may be a different tier in different packs.
    // Drives the default weight split for unlocked rows (see @acme/odds-math) and the
    // storefront tier badge. Default keeps legacy/diff-created rows valid.
    // NULL for reward entries (kind IS NOT NULL).
    rarity: model
      .enum(['Immortal', 'Legendary', 'Mythical', 'Rare', 'Uncommon', 'Common'])
      .nullable(),
    // Relative pull weight: roll chance = weight / Σ(weights in the pack), so the
    // roll is scale-invariant (the seed ships rarity-relative weights that need
    // not sum to anything in particular). The admin win-rate editor (Phase 6b)
    // NORMALIZES a pack to BASIS POINTS on save (Σweight = 10000), so afterwards
    // weight/100 reads back as the exact win % the operator set.
    weight: model.number(),
    // locked rows keep their admin-set % verbatim on every save; unlocked rows
    // split the remaining (10000 − Σlocked) bps evenly. Phase 6b.
    locked: model.boolean().default(false),
    // Admin-picked "Top Hits" flag — flagged cards ARE the pack page's Top
    // Hits section (display only, no effect on the draw). No flags on a pack
    // ⇒ the storefront falls back to its highest-value cards.
    top_hit: model.boolean().default(false),
    // A2 — reward prize entry columns. kind is model-owned (db:generate emits
    // the single-col CHECK); the cross-col payout CHECK is hand-written below.
    kind: model.enum(['product', 'credit', 'nothing']).nullable(),
    product_handle: model.text().nullable(),
    // credit payout in decimal MYR — bigNumber maps to numeric + raw_ sidecar.
    credit_amount: model.bigNumber().nullable(),
  })
  .indexes([
    // gacha-table build per pack (roll-pack) + admin odds editor + members.
    {
      name: 'IDX_pack_odds_pack_id',
      on: ['pack_id'],
      where: 'deleted_at IS NULL',
    },
    // rarity enrichment joins on the live feed / vault / profile (card_id IN ...).
    {
      name: 'IDX_pack_odds_card_id',
      on: ['card_id'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default PackOdds;
