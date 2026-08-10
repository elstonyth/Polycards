/**
 * Display tiers, apex first. Mirrors the `pack_odds.rarity` enum
 * (models/pack-odds.ts) and the storefront's RARITY_ORDER (src/lib/rarity.ts) —
 * the three lists must agree, because the tier decides the frame colour a
 * customer sees.
 *
 * Rarity is a PACK-level property: the same card can sit in several packs at
 * different tiers, so "this card's rarity" is only ever a question about a
 * given pack, or — for a context-free deep link — the best tier it holds
 * anywhere (see bestRarity).
 */
export const RARITY_ORDER = [
  'Immortal',
  'Legendary',
  'Mythical',
  'Rare',
  'Uncommon',
  'Common',
] as const;

export type Rarity = (typeof RARITY_ORDER)[number];

/** Rank for sorting: 0 = apex. Unknown tiers sort last rather than throwing —
 *  a row written by an older enum must not blank the frame. */
export const rarityRank = (rarity: string | null | undefined): number => {
  const i = RARITY_ORDER.indexOf(rarity as Rarity);
  return i === -1 ? RARITY_ORDER.length : i;
};

/** The highest tier among the given rows, or null when there is none. */
export const bestRarity = (
  rarities: readonly (string | null | undefined)[],
): Rarity | null => {
  let best: Rarity | null = null;
  for (const r of rarities) {
    if (!r || rarityRank(r) === RARITY_ORDER.length) continue;
    if (best === null || rarityRank(r) < rarityRank(best)) best = r as Rarity;
  }
  return best;
};
