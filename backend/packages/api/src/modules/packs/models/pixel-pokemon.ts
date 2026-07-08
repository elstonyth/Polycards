import { model } from '@medusajs/framework/utils';

// PixelPokemon — the pixel-sprite library each Card links to by id (Spec 2).
// One "normal" row per national dex is seeded (encyclopedia); admins add
// variants / custom uploads later. `dex` is grouping/display only (NOT unique —
// many variants can share a dex); the id is the unique link key. `image_url` is
// a Spaces-hosted sprite (the "sprite not loaded" root fix); null → the
// storefront renders its poké-ball fallback. `types` is always written as a
// string[] (possibly empty).
export const PixelPokemon = model
  .define('pixel_pokemon', {
    id: model.id().primaryKey(),
    name: model.text(),
    dex: model.number().nullable(),
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
  ]);

export default PixelPokemon;
