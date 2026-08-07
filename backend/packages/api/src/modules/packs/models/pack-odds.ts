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
    // SET 1 (default) relative pull weight: roll chance = weight / Σ(weights in
    // the pack), so the roll is scale-invariant (the seed ships rarity-relative
    // weights that need not sum to anything in particular). The admin win-rate
    // editor NORMALIZES a pack to integer units on save (Σweight = 1,000,000),
    // so afterwards weight/PCT_SCALE reads back as the exact 4-decimal win %
    // the operator set.
    weight: model.number(),
    // COMMON IS THE BALANCER (POLYCARD-BACK §2.4): on save every non-Common row
    // keeps its submitted % verbatim — locked or not — and locked Common rows
    // are pinned too; only UNLOCKED Common rows absorb the remaining
    // (1,000,000 − Σpinned) units, split evenly. So `locked` no longer decides who
    // floats, it only pins a Common. See @acme/odds-math balanceOdds.
    locked: model.boolean().default(false),
    // Win-rate sets 2 and 3 (POLYCARD-BACK §2.4 / D2). Integer units like
    // `weight` (set 1). NULL = "inherit the previous set" PER CARD (2→1, 3→2)
    // — resolution lives in odds-sets.ts weightForSet(). After any save, every
    // set's RESOLVED weights sum to 1,000,000 (save-pack-odds re-balances all
    // three sets). `locked` is shared across sets; only the pinned % differs.
    weight_2: model.number().nullable(),
    weight_3: model.number().nullable(),
    // Admin-picked "Top Hits" display order (display only, no effect on the
    // draw): 1 renders leftmost on the pack page, then 2, 3, … null = not a
    // Top Hit. No ordered rows on a pack ⇒ the storefront HIDES the section
    // (no highest-value fallback — that made empty packs look curated).
    top_hit_order: model.number().nullable(),
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
    // One CARD row per (pack, card): the reconcile diff computes membership from
    // a paged read, but a missed page (or a racing edit) must never silently
    // create a second row for the same card — that doubles its draw weight
    // invisibly. Partial + card_id IS NOT NULL so reward_box packs keep holding
    // multiple null-card prize rows.
    {
      name: 'UQ_pack_odds_pack_card',
      on: ['pack_id', 'card_id'],
      unique: true,
      where: 'deleted_at IS NULL AND card_id IS NOT NULL',
    },
  ]);

export default PackOdds;
