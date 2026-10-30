import { model } from '@medusajs/framework/utils';

// PixelPokemon — the pixel-sprite library each Card links to by id (Spec 2).
// One "normal" row per national dex is seeded (encyclopedia); admins add
// variants / custom uploads later. `dex` is grouping/display only (NOT unique —
// many variants can share a dex); the id is the unique link key. `image_url` is
// a Spaces-hosted sprite (the "sprite not loaded" root fix); null → the
// storefront renders its poké-ball fallback. `types` is always written as a
// string[] (possibly empty).
//
// `franchise` keeps the decks apart (a pack's category: 'pokemon' |
// 'one-piece'). Pokémon rows are numbered by `dex`; every other franchise by
// `number` (One Piece #001 Luffy…), which is NEVER read as a dex — the card
// mirror only copies `dex` for Pokémon, so One Piece #25 can't become Pikachu.
// Variants share their character's number (Gear 5 Luffy = One Piece #001,
// variant 'gear-5'), like Pokémon forms share a dex.
export const PixelPokemon = model
  .define('pixel_pokemon', {
    id: model.id().primaryKey(),
    name: model.text(),
    dex: model.number().nullable(),
    franchise: model.text().default('pokemon'),
    number: model.number().nullable(),
    variant: model.text().default('normal'),
    types: model.json(),
    image_url: model.text().nullable(),
    image_key: model.text().nullable(),
    is_custom: model.boolean().default(false),
  })
  .indexes([
    {
      // Exactly one seeded "normal" row per national dex. The seed and backfill
      // both resolve a single (dex, 'normal') match, so enforce it at the DB —
      // a concurrent/interrupted seed can't silently create a duplicate the
      // backfill would then link arbitrarily (CodeRabbit). Custom variants and
      // dex-less custom rows are unconstrained (partial index).
      name: 'UQ_pixel_pokemon_dex_normal',
      on: ['dex'],
      unique: true,
      where: "variant = 'normal' AND deleted_at IS NULL",
    },
    {
      // One base ("normal") sprite per number within a non-Pokémon franchise.
      name: 'UQ_pixel_pokemon_franchise_number_normal',
      on: ['franchise', 'number'],
      unique: true,
      where: "variant = 'normal' AND number IS NOT NULL AND deleted_at IS NULL",
    },
  ]);

export default PixelPokemon;
