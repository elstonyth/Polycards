import type PacksModuleService from './service';

// Medusa's MedusaService derives CRUD method names by pluralizing the model
// name with a library that treats "pokemon" as UNCOUNTABLE. So the runtime
// methods for the `pixel_pokemon` model are SINGULAR-form —
// `listPixelPokemon` / `createPixelPokemon` / `updatePixelPokemon` — while the
// GENERATED TYPES use naive `+s` (`listPixelPokemons` …). Calling the typed
// name throws at runtime ("is not a function"); calling the runtime name fails
// tsc. This accessor bridges the gap once: it binds the accurate generated
// signatures to the real runtime names via a single explicit cast, so every
// caller (seed, backfill, and Plan 2's admin routes) gets a correctly-typed,
// runtime-correct API and never has to know about the divergence.
//
// ponytail: a typed name-remap, not an `any` escape hatch — the signatures are
// the real generated ones. If the pixel_pokemon model is ever renamed to a
// countable word (type==runtime again), delete this file and call packs directly.
export type PixelPokemonCrud = {
  listPixelPokemon: PacksModuleService['listPixelPokemons'];
  createPixelPokemon: PacksModuleService['createPixelPokemons'];
  updatePixelPokemon: PacksModuleService['updatePixelPokemons'];
};

export const asPixelPokemonCrud = (
  packs: PacksModuleService,
): PixelPokemonCrud => packs as unknown as PixelPokemonCrud;
