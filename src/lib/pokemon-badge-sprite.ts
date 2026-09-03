// The sprite-source decision behind PokemonBadge, kept out of the component so
// it is testable without a DOM (vitest collects src/**/*.test.ts only).
import { resolveCardPokemon } from '@/lib/resolve-card-pokemon';
import { spriteGif, spritePng } from '@/lib/mock/pokedex';

export type BadgeCard = {
  name: string;
  pokemonDex?: number | null;
  spriteImage?: string | null;
};

export type BadgeSprite = {
  /** Resolved Pokémon name — the badge's alt text; null = no Pokémon. */
  name: string | null;
  /** Sources to try in order. Empty = render no badge. */
  chain: string[];
};

/**
 * Resolve a card to its badge sprite chain.
 *
 * The custom upload leads when an admin set one, then the dex sprites follow —
 * matching the reel (PokemonToken: `imageSrc ?? spriteGif(dex)` then gif → png).
 * The dex tail is NOT optional after a custom sprite: an operator-entered URL is
 * the most rot-prone link here (a deleted Spaces object, a typo, a host the CSP
 * refuses), and dropping it would blank the badge on a card whose dex is known
 * and whose reel cell still renders. Reel and card fall back the same way, which
 * is what keeps them showing the same Pokémon.
 *
 * `still` swaps the animated showdown gif for the static png — set it for a
 * reduced-motion visitor. A gif cannot be paused by CSS, so this is the only
 * lever; the png is the same sprite, so the card↔reel mapping survives it.
 */
export function badgeSprite(card: BadgeCard, still = false): BadgeSprite {
  // resolveCardPokemon takes snake_case; PackCard carries camelCase. Both
  // fields are optional there, so an unmapped call compiles clean and silently
  // drops the admin's configured pixel-Pokémon — the case test 1 pins.
  const { dex, name } = resolveCardPokemon({
    name: card.name,
    pokemon_dex: card.pokemonDex,
    sprite_image: card.spriteImage,
  });
  const custom = card.spriteImage?.trim() ? card.spriteImage : null;
  const dexChain =
    dex === null
      ? []
      : still
        ? [spritePng(dex)]
        : [spriteGif(dex), spritePng(dex)];
  return { name, chain: custom ? [custom, ...dexChain] : dexChain };
}
