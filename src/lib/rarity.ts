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

/** Rarities high→low — drives filter-chip order. */
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
