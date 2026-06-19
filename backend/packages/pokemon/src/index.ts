// @acme/pokemon — pixel-Pokémon resolution data shared by the admin dashboard.
// SOURCE-BASED (no dist/build): main/types -> ./src/index.ts. Admin-only consumer.
//
// NOTE: the storefront keeps its OWN copies of these files (separate workspace —
// src/lib/pokemon-from-card.ts, src/lib/mock/pokedex.ts, src/lib/mock/pokedex-names.ts).
// This is intentional dex-data duplication; keep the two in sync when editing.
export type { CardPokemon } from './pokemon-from-card';
export { pokemonFromCard } from './pokemon-from-card';
export { POKEDEX_NAMES } from './pokedex-names';
export { spriteGif, spritePng } from './pokedex';
