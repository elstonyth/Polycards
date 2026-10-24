import { MedusaError } from '@medusajs/framework/utils';
import type PacksModuleService from './service';
import { asPixelPokemonCrud } from './pixel-pokemon-service';

// Spec 2 §4 mirror-at-write. The linked PixelPokemon is the source of truth for
// "which pokémon"; these mirrored Card columns are a render cache of that choice,
// so the storefront resolver stays unchanged (it already prefers sprite_image /
// pokemon_dex). Backfill apply (Plan 1) and the admin update-card step (Plan 2)
// both write these fields whenever a card's pixel_pokemon_id is (re)assigned.
export type PixelPokemonLike = {
  dex: number | null;
  image_url: string | null;
  /** Missing = a pre-franchise row, i.e. Pokémon (the column default). */
  franchise?: string | null;
};
export type MirroredCardFields = {
  pokemon_dex: number | null;
  sprite_image: string | null;
};

export function mirroredCardFields(pp: PixelPokemonLike): MirroredCardFields {
  const pokemon = (pp.franchise ?? 'pokemon') === 'pokemon';
  return {
    // Only a Pokémon's dex lands on the card: the storefront reads
    // card.pokemon_dex as a Pokémon (sprite fallback, reel identity), so any
    // other deck's entry stays dex-less there no matter what the row holds.
    pokemon_dex: pokemon ? (pp.dex ?? null) : null,
    sprite_image: pp.image_url ?? null,
  };
}

// The Card columns to WRITE for a given `pixel_pokemon_id` intent from the admin
// card forms (Spec 2 §5 — id-only). Under the id-first picker the LINK is the
// source of truth and pokemon_dex/sprite_image are its render cache, so the
// forms never set the mirror directly — they only pick an id, and the backend
// derives the mirror from it here. Semantics deliberately mirror pc_product_id
// (validate.ts optPcId): the form round-trips the field and only sends it when
// it CHANGED, so a save that doesn't touch the picker preserves a linked card's
// sprite (the partial-save-wipe guard):
//   undefined → not provided (picker untouched): leave all three columns as-is.
//   null      → link cleared: unlink + clear the mirror → the card falls back
//               to name-derivation on the storefront.
//   string    → an entry was picked: link it and mirror its dex + image_url.
export type PixelPokemonPatch = {
  pixel_pokemon_id?: string | null;
  pokemon_dex?: number | null;
  sprite_image?: string | null;
};

export async function resolvePixelPokemonPatch(
  packs: PacksModuleService,
  pixelPokemonId: string | null | undefined,
): Promise<PixelPokemonPatch> {
  if (pixelPokemonId === undefined) return {};
  if (pixelPokemonId === null) {
    return { pixel_pokemon_id: null, pokemon_dex: null, sprite_image: null };
  }
  // asPixelPokemonCrud: the runtime CRUD method is SINGULAR (listPixelPokemon),
  // while the generated type is +s — the accessor bridges the divergence so tsc
  // and runtime agree (see pixel-pokemon-service.ts).
  const [pp] = await asPixelPokemonCrud(packs).listPixelPokemon(
    { id: pixelPokemonId },
    { take: 1 },
  );
  if (!pp) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Pixel-Pokémon '${pixelPokemonId}' not found.`,
    );
  }
  return { pixel_pokemon_id: pixelPokemonId, ...mirroredCardFields(pp) };
}
