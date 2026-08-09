import { pokemonFromCard } from '@acme/pokemon';
import { getPixelPokemon, type PixelPokemonRow } from './admin-rest';

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

// Species-keyed promise memo: the bulk collection import mounts one picker per
// draft and many drafts share a species — identical lookups collapse into one
// request instead of a per-instance burst. variant/custom filters keep the page
// to SEEDED rows only, so custom rows sharing the name can never push the
// target dex past the page limit.
// ponytail: distinct species still fetch concurrently (≤ a few dozen parallel
// admin GETs per import); add a queue if imports ever outgrow that.
const seededByQuery = new Map<string, Promise<PixelPokemonRow[]>>();

export const fetchSeededCandidates = (q: string): Promise<PixelPokemonRow[]> => {
  let p = seededByQuery.get(q);
  if (!p) {
    p = getPixelPokemon({ q, variant: 'normal', custom: 'false' }).then(
      (page) => page.pixel_pokemon,
    );
    // A failed fetch must not poison the memo — drop it so a later mount retries.
    p.catch(() => seededByQuery.delete(q));
    seededByQuery.set(q, p);
  }
  return p;
};
