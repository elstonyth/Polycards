import { pokemonFromCard } from '@acme/pokemon';
import type { PixelPokemonRow } from './admin-rest';

// From-PC auto-resolve: derive the species from a (suffixed) PC product name
// ("Pikachu with Grey Felt Hat #85") and pick its SEEDED normal-variant library
// row from a fetched page. Dex-keyed, never name-keyed, so custom rows whose
// names merely contain the species can't win. Null = no confident match — the
// operator links by hand (the required gate stays the backstop).
export const matchSeededEntry = (
  cardName: string,
  rows: PixelPokemonRow[],
): PixelPokemonRow | null => {
  const hit = pokemonFromCard(cardName);
  if (!hit) return null;
  return (
    rows.find(
      (r) => r.dex === hit.dex && r.variant === 'normal' && !r.is_custom,
    ) ?? null
  );
};

/** The q= to fetch candidate rows for matchSeededEntry, or null when the name
 *  has no resolvable species. */
export const autoResolveQuery = (cardName: string): string | null =>
  pokemonFromCard(cardName)?.name ?? null;
