import { allPokemonMatches } from '@acme/pokemon';
import { mirroredCardFields } from '../modules/packs/card-pixel-pokemon';

// One row of the human-verified backfill review file (Spec 2 §3). `chosen_dex`
// is the ONLY human-editable field: propose defaults it to the first match; a
// person corrects it for `ambiguous` rows (e.g. Rockruff → 745 Lycanroc) before
// apply. Everything else is diagnostic.
export type ReviewRow = {
  card_id: string;
  card_name: string;
  proposed_dex: number | null;
  proposed_species: string | null;
  all_matches: { dex: number; name: string }[];
  ambiguous: boolean;
  chosen_dex: number | null;
};

export function proposeRow(card: { id: string; name: string }): ReviewRow {
  const matches = allPokemonMatches(card.name);
  const proposed = matches[0] ?? null;
  return {
    card_id: card.id,
    card_name: card.name,
    proposed_dex: proposed?.dex ?? null,
    proposed_species: proposed?.name ?? null,
    all_matches: matches,
    ambiguous: matches.length >= 2,
    chosen_dex: proposed?.dex ?? null,
  };
}

// The Card patch that links a reviewed row to its seeded "normal" PixelPokemon
// and mirrors its render fields (Spec 2 §4). Null when the row has no chosen dex
// or no seeded entry for it — that card stays name-derived (poké-ball fallback).
export type CardPatch = {
  id: string;
  pixel_pokemon_id: string;
  pokemon_dex: number | null;
  sprite_image: string | null;
};

export function applyRow(
  row: ReviewRow,
  pixelByDex: Map<
    number,
    { id: string; dex: number | null; image_url: string | null }
  >,
): CardPatch | null {
  if (row.chosen_dex == null) return null;
  const pixel = pixelByDex.get(row.chosen_dex);
  if (!pixel) return null;
  return {
    id: row.card_id,
    pixel_pokemon_id: pixel.id,
    ...mirroredCardFields(pixel),
  };
}
