import type { Rarity } from '@/lib/packs-data';

/**
 * Rarity color RGB (as "r, g, b") — feed `rgba(${rarityRgb(r)}, a)`.
 * THE canonical six-tier color map (fixed by product spec):
 * Immortal orange · Legendary bright pink · Mythical purple · Rare dark blue ·
 * Uncommon light blue · Common gray.
 */
export const RARITY_RGB: Record<Rarity, string> = {
  Immortal: '251, 146, 60', // orange-400
  Legendary: '236, 72, 153', // pink-500
  Mythical: '168, 85, 247', // purple-500
  Rare: '37, 99, 235', // blue-600
  Uncommon: '56, 189, 248', // sky-400
  Common: '163, 163, 163', // neutral-400
};

/** Canonical rarity tiers, high→low — drives filter-chip order + display/iteration
 *  order. Single source; `RARITIES` in `@/lib/packs-format` re-exports this. */
export const RARITY_ORDER: readonly Rarity[] = [
  'Immortal',
  'Legendary',
  'Mythical',
  'Rare',
  'Uncommon',
  'Common',
];

/** Tolerant lookup for backend rarity strings; unknown values read as Common. */
export function rarityRgb(rarity: string): string {
  return RARITY_RGB[rarity as Rarity] ?? RARITY_RGB.Common;
}

/** The tiers that get the celebration treatment (reveal ribbon, big-win
 *  sound/haptics). Top three of RARITY_ORDER by product spec. */
export const TOP_RARITIES: readonly Rarity[] = [
  'Immortal',
  'Legendary',
  'Mythical',
];

/** Tolerant check for backend rarity strings. */
export function isTopRarity(rarity: string): boolean {
  return (TOP_RARITIES as readonly string[]).includes(rarity);
}

/**
 * Win-sound playback volume by tier: a SUBTLE taper — Immortal 1.0 down to only
 * Common 0.85 in even steps of RARITY_ORDER. Every tier sounds almost the same,
 * just gently tuned down as rarity drops (not a dramatic loud/quiet split).
 * Unknown rarities read as Common (quietest).
 */
export function rarityWinVolume(rarity: string): number {
  const idx = RARITY_ORDER.indexOf(rarity as Rarity);
  return 1 - 0.03 * (idx === -1 ? RARITY_ORDER.length - 1 : idx);
}
