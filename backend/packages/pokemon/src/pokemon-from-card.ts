// @acme/pokemon — pokemon-from-card.ts (verbatim copy of the storefront's
// src/lib/pokemon-from-card.ts; only the POKEDEX_NAMES import path is adjusted
// for this package's flat src/ layout).
import { POKEDEX_NAMES } from './pokedex-names';

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

/**
 * Every distinct species whose name (full OR base-species) is a substring of the
 * card name. Unlike pokemonFromCard (first match only), this surfaces
 * evolution-family collisions — a card whose name contains two species
 * ("Rockruff … Lycanroc") returns both, so the backfill can flag it ambiguous
 * instead of silently linking to the first.
 *
 * Matches against BOTH indexes, deduped by dex (keeping the longest matched
 * token per dex):
 *   - INDEX     — full normalized dex names ("rockruff", "mewtwo").
 *   - BASE_INDEX — the base species of a form-labeled dex entry ("lycanroc" from
 *     "Lycanroc Midday", "shaymin" from "Shaymin Land"). REQUIRED: the real
 *     Rockruff card says "Lycanroc GX", never "Lycanroc Midday", so the full
 *     name "lycanrocmidday" never matches — only the base "lycanroc" (dex 745)
 *     does. Without this pass the card would flag as NOT ambiguous and silently
 *     link to Rockruff (744), the pre-evolution — the exact bug this exists to
 *     kill. (BASE_INDEX already excludes <5-char bases, full names, and known
 *     non-species prefixes, so it can't false-hit a real species.)
 *
 * Then drops a hit whose token is contained in a longer hit's token ("mew"
 * inside "mewtwo") — the longer species already covers that region, so it is not
 * a real second species. Genuine collisions where neither contains the other
 * (rockruff vs lycanroc) survive. May over-report on rare coincidental
 * substrings — the SAFE direction (a human confirms flagged rows in backfill).
 */
export function allPokemonMatches(cardName: string): CardPokemon[] {
  const hay = normalize(cardName);
  if (!hay) return [];
  // Longest matched token per dex, across both indexes.
  const bestNorm = new Map<number, string>();
  const consider = (dex: number, norm: string): void => {
    if (!hay.includes(norm)) return;
    const prev = bestNorm.get(dex);
    if (!prev || norm.length > prev.length) bestNorm.set(dex, norm);
  };
  for (const { dex, norm } of INDEX) consider(dex, norm);
  for (const { dex, norm } of BASE_INDEX) consider(dex, norm);

  const hits = [...bestNorm.entries()].map(([dex, norm]) => ({ dex, norm }));
  // Drop a hit whose token is contained in a longer hit's token so a single
  // species can't self-flag as ambiguous (every "Mewtwo" card contains "mew").
  // Known limit (sourcery): a tag-team card naming two species where one name
  // contains the other ("Mewtwo & Mew") keeps only the longer (Mewtwo) — a
  // defensible single sprite for a dual-species card. Tracking token positions
  // to keep both isn't worth the complexity in a human-reviewed flow.
  const filtered = hits.filter(
    (h) => !hits.some((o) => o.norm !== h.norm && o.norm.includes(h.norm)),
  );
  // Longest token first (most specific), mirroring pokemonFromCard's ordering.
  filtered.sort((a, b) => b.norm.length - a.norm.length);
  return filtered.map((h) => ({ dex: h.dex, name: POKEDEX_NAMES[h.dex - 1] }));
}
