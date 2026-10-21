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

/** Pack categories (backend `pack.category` keys) whose cards are never
 *  Pokémon. Anything else — pokemon, plus free_welcome / reward_box, which
 *  carry Pokémon prizes — keeps the Pokémon resolution. */
const NON_POKEMON_CATEGORIES: ReadonlySet<string> = new Set([
  'one-piece',
  'basketball',
  'baseball',
  'football',
  'soccer',
  'yugioh',
  'riftbound',
]);

/** False for a One Piece / sports / … pack: its cards must never resolve to a
 *  Pokémon (no dex, no name-derivation) — the decks don't mix. */
export const isPokemonPack = (categoryId: string | null | undefined): boolean =>
  !NON_POKEMON_CATEGORIES.has(categoryId ?? '');

export function resolveCardPokemon(
  card: CardPokemonInput,
  { pokemon = true }: { pokemon?: boolean } = {},
): ResolvedCardPokemon {
  // In a non-Pokémon pack even a stray configured dex is ignored: only the
  // card's own custom sprite may show.
  const explicit =
    pokemon && validDex(card.pokemon_dex) ? card.pokemon_dex : null;
  const custom =
    card.sprite_image && card.sprite_image.trim() !== ''
      ? card.sprite_image
      : null;
  // Name-derivation only for cards with NOTHING configured. A custom sprite
  // without a dex is a deliberate non-Pokémon pick (One Piece characters): its
  // name must not be mined for a species — "Bartholomew Kuma" contains "mew",
  // which would put Mew in that pack's reel.
  const fallback =
    pokemon && explicit === null && custom === null
      ? pokemonFromCard(card.name)
      : null;
  const dex = explicit ?? fallback?.dex ?? null;
  const name =
    explicit !== null
      ? (POKEDEX_NAMES[explicit - 1] ?? null)
      : (fallback?.name ?? null);
  const sprite = custom ?? (dex !== null ? spriteGif(dex) : null);
  return { dex, name, sprite };
}
