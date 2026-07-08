import { model } from '@medusajs/framework/utils';
import { DEFAULT_MARKET_MULTIPLIER } from '../pricing';

// Card — the gacha prize metadata referenced by PackOdds (weights) and Pull
// (results). In Phase 5a it carries its own display fields so the read-only
// catalog depth (Top Hits / Pull Odds) needs no cross-module join. Phase 5b
// links each Card to the Medusa Product whose variant carries inventory +
// checkout; `handle` is that product's handle (the future link key, and the
// stable id PackOdds/Pull reference).
export const Card = model.define('card', {
  id: model.id().primaryKey(),
  handle: model.text().unique(),
  name: model.text(),
  set: model.text(),
  grader: model.text(),
  grade: model.text(),
  // NOTE: rarity is NOT a card property — the same card can be Mythical in one pack
  // and Rare in another. It lives on PackOdds (the pack↔card link).
  // USD fair-market value — THE ONLY USD IN THE SYSTEM (raw PriceCharting FMV).
  // Converted to MYR ONLY via modules/packs/pricing.ts. A DECIMAL, never cents.
  // bigNumber maps to a numeric column; model.number() would map to integer and
  // truncate the cents.
  market_value: model.bigNumber(),
  image: model.text(),
  // Baked graded-slab composite (frame + photo, one webp) — public URL plus
  // the file provider's id. The key exists ONLY so a re-bake can delete the
  // previous file; it is never exposed on any API or mirrored into product
  // metadata. Null = raw card (empty grader), not yet baked, or bake failed —
  // all three render the bare `image`.
  slab_image: model.text().nullable(),
  slab_image_key: model.text().nullable(),
  // Standalone sale price (RM decimal — it mirrors onto the MYR product
  // variant price). The card's *intended* marketplace price,
  // kept here even while `for_sale` is off so toggling it back on has a price to
  // restore. On save the admin mirror writes this onto the matching Medusa Product
  // variant (the actual sellable entity). Nullable: pre-existing seeded cards had
  // no Card-level price (their price lived on the seeded Product) until first edit.
  price: model.bigNumber().nullable(),
  // Listed on the storefront marketplace. When true the admin mirror keeps a
  // PUBLISHED Medusa Product (handle === Card.handle); when false the Product is
  // set to draft. Defaults true so the 51 already-seeded cards (all published as
  // Products) keep matching their live marketplace listings.
  for_sale: model.boolean().default(true),
  // Pixel-Pokémon avatar (1:1 per card). national-dex number, 1-based. Nullable:
  // existing cards resolve via name-derivation (pokemonFromCard) until an admin
  // assigns one. model.number() (NOT bigNumber) — an integer dex, distinct from
  // the bigNumber money columns above.
  pokemon_dex: model.number().nullable(),
  // Optional custom uploaded pixel sprite URL; overrides the dex default gif.
  sprite_image: model.text().nullable(),
  // Spec 2: link to a PixelPokemon library entry by its unique id — the
  // authoritative "which pixel pokémon". Same-module nullable FK (a plain id
  // column, not a Medusa link). On link, the entry's image_url/dex are mirrored
  // onto sprite_image/pokemon_dex above (render cache) so the storefront
  // resolver is unchanged. Null = legacy/unlinked card (name-derivation fallback).
  pixel_pokemon_id: model.text().nullable(),
  // PriceCharting linkage (live market-price tracking). product id links this
  // Card to a PriceCharting catalog entry; grade is PC's own grade label
  // (e.g. "PSA 10") for picking the right price field off that product.
  pc_product_id: model.text().nullable(),
  pc_grade: model.text().nullable(),
  // Display-only markup applied over the raw PriceCharting price (never
  // mutates market_value itself). bigNumber (decimal), default 1.2 = +20%.
  market_multiplier: model.bigNumber().default(DEFAULT_MARKET_MULTIPLIER),
  // Last time this card's price was synced from PriceCharting; null = never.
  pc_synced_at: model.dateTime().nullable(),
});

export default Card;
