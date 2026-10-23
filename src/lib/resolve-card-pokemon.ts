// The single canonical card→Pokémon resolution rule (storefront copy). Mirrors
// the backend admin rule in @acme/pokemon. Explicit fields win; name-derivation
// (pokemonFromCard) is the graceful fallback so unassigned cards keep working.
import { pokemonFromCard } from '@/lib/pokemon-from-card';
import { POKEDEX_NAMES } from '@/lib/mock/pokedex-names';
import { spriteGif } from '@/lib/mock/pokedex';

export type CardPokemonInput = {
  name: string;
  pokemon_dex?: number | null;
  sprite_image?: string | null;
};

export type ResolvedCardPokemon = {
  dex: number | null;
  name: string | null;
  sprite: string | null;
};

// Derive the bound; never hardcode 1025. NOTE: the backend mirrors this as a
// hardcoded literal (MAX_DEX = 1025) in
// backend/packages/api/src/api/admin/cards/validate.ts — keep the two in sync if
// the dex list grows (that file is the one that won't auto-track this length).
const MAX_DEX = POKEDEX_NAMES.length;

const validDex = (d: number | null | undefined): d is number =>
  typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= MAX_DEX;

/** Pack categories (backend `pack.category` keys) whose cards ARE Pokémon:
 *  'pokemon' from the admin's closed category list
 *  (backend/apps/admin/src/routes/packs/page.tsx CATEGORIES), plus the reserved
 *  free_welcome / reward_box packs, which carry Pokémon prizes. An allowlist on
 *  purpose: one-piece, basketball… and any category added later default to
 *  non-Pokémon, so a new deck can never inherit Pokémon filler. */
const POKEMON_CATEGORIES: ReadonlySet<string> = new Set([
  'pokemon',
  'free_welcome',
  'reward_box',
]);

/** False for a One Piece / sports / … pack: its cards must never resolve to a
 *  Pokémon (no dex, no name-derivation) — the decks don't mix. An unknown
 *  context (no category at hand) keeps the Pokémon behaviour. */
export const isPokemonPack = (categoryId: string | null | undefined): boolean =>
  categoryId == null || POKEMON_CATEGORIES.has(categoryId);

/**
 * `pokemon` — what the caller knows about the card's pack (isPokemonPack):
 *   true      a Pokémon pack: a card with no dex derives one from its name even
 *             when it has a custom sprite (the dex is the badge's fallback if
 *             that sprite's URL ever breaks).
 *   undefined no pack context (vault, /card/<handle>): derive only for a card
 *             with NOTHING configured — a dex-less custom sprite may be a One
 *             Piece character, and "Bartholomew Kuma" contains "mew".
 *   false     a One Piece / sports pack: never a Pokémon, not even a stray dex.
 */
export function resolveCardPokemon(
  card: CardPokemonInput,
  { pokemon }: { pokemon?: boolean } = {},
): ResolvedCardPokemon {
  const explicit =
    pokemon !== false && validDex(card.pokemon_dex) ? card.pokemon_dex : null;
  const custom =
    card.sprite_image && card.sprite_image.trim() !== ''
      ? card.sprite_image
      : null;
  const derive =
    explicit === null &&
    (pokemon === true || (pokemon === undefined && custom === null));
  const fallback = derive ? pokemonFromCard(card.name) : null;
  const dex = explicit ?? fallback?.dex ?? null;
  const name =
    explicit !== null
      ? (POKEDEX_NAMES[explicit - 1] ?? null)
      : (fallback?.name ?? null);
  const sprite = custom ?? (dex !== null ? spriteGif(dex) : null);
  return { dex, name, sprite };
}
