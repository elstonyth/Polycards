// Spec 2 §4 mirror-at-write. The linked PixelPokemon is the source of truth for
// "which pokémon"; these mirrored Card columns are a render cache of that choice,
// so the storefront resolver stays unchanged (it already prefers sprite_image /
// pokemon_dex). Backfill apply (Plan 1) and the admin update-card step (Plan 2)
// both write these fields whenever a card's pixel_pokemon_id is (re)assigned.
export type PixelPokemonLike = { dex: number | null; image_url: string | null };
export type MirroredCardFields = {
  pokemon_dex: number | null;
  sprite_image: string | null;
};

export function mirroredCardFields(pp: PixelPokemonLike): MirroredCardFields {
  return {
    pokemon_dex: pp.dex ?? null,
    sprite_image: pp.image_url ?? null,
  };
}
