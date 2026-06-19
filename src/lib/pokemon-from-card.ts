// src/lib/pokemon-from-card.ts
import { POKEDEX_NAMES } from './mock/pokedex-names';

export type CardPokemon = { dex: number; name: string };

/** Fold to comparison form: lowercase, drop every non-alphanumeric char. */
const normalize = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Build once: every dex name in normalized form, sorted LONGEST-FIRST so the
// first substring hit is the most specific Pokémon ("mewtwo" before "mew").
const INDEX: ReadonlyArray<{ dex: number; norm: string }> = POKEDEX_NAMES.map(
  (name, i) => ({ dex: i + 1, norm: normalize(name) }),
)
  .filter((e) => e.norm.length > 0)
  .sort((a, b) => b.norm.length - a.norm.length);

const FULL_NAMES = new Set(INDEX.map((e) => e.norm));

// First words of multi-word dex names that are NOT the species (paradox mons,
// Treasures of Ruin). These must never be base-indexed. Shorter non-species
// prefixes ("mr", "ho", "type", "tapu", "iron", "ting"…) are excluded by the
// length guard below instead.
const NON_SPECIES_FIRST = new Set([
  'brute', // Brute Bonnet
  'chien', // Chien-Pao
  'flutter', // Flutter Mane
  'gouging', // Gouging Fire
  'great', // Great Tusk
  'raging', // Raging Bolt
  'roaring', // Roaring Moon
  'sandy', // Sandy Shocks
  'scream', // Scream Tail
  'slither', // Slither Wing
  'walking', // Walking Wake
]);

// Base-species fallback: the first word of a form-labeled dex entry ("Shaymin
// Land" → "shaymin", "Deoxys Normal" → "deoxys"), so a card that omits the form
// word ("Shaymin VSTAR") still resolves to the right Pokémon. LAST-RESORT only
// (after every full-name match fails), longest-first, and excluded when the base
// is <5 chars, already a full dex name, or a known non-species prefix — so a
// wrong match is impossible for real species and at worst cosmetic otherwise.
const BASE_INDEX: ReadonlyArray<{ dex: number; norm: string }> =
  POKEDEX_NAMES.map((name, i) => ({
    dex: i + 1,
    norm: normalize(name.trim().split(/\s+/)[0] ?? ''),
  }))
    .filter(
      (e) =>
        e.norm.length >= 5 &&
        !FULL_NAMES.has(e.norm) &&
        !NON_SPECIES_FIRST.has(e.norm),
    )
    .sort((a, b) => b.norm.length - a.norm.length);

/**
 * Parse the Pokémon out of a card name (spec §2). Normalized longest-match
 * against the national Pokédex, then a base-species fallback for form-labeled
 * entries. Returns null only for cards with no resolvable Pokémon
 * (trainer/energy/item) — callers render the §2/G5 fallback.
 */
export function pokemonFromCard(cardName: string): CardPokemon | null {
  const hay = normalize(cardName);
  if (!hay) return null;
  for (const { dex, norm } of INDEX) {
    if (hay.includes(norm)) return { dex, name: POKEDEX_NAMES[dex - 1] };
  }
  for (const { dex, norm } of BASE_INDEX) {
    if (hay.includes(norm)) return { dex, name: POKEDEX_NAMES[dex - 1] };
  }
  return null;
}
