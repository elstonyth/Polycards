import type { Rarity } from '@/lib/packs-data';

/**
 * Rarity glow RGB (as "r, g, b") — feed `rgba(${rarityRgb(r)}, a)`.
 * Canonical copy of the RARITY_RING values used by the pack reveal
 * (PackDetailClient / PackOpenOverlay keep local copies; fold them into this
 * during the redesign route sweep).
 */
export const RARITY_RGB: Record<Rarity, string> = {
  Immortal: '251, 146, 60',
  Legendary: '234, 179, 8',
  Epic: '217, 70, 239',
  Rare: '56, 189, 248',
  Uncommon: '52, 211, 153',
  Common: '163, 163, 163',
};

/** Rarities high→low — drives filter-chip order. */
export const RARITY_ORDER: readonly Rarity[] = [
  'Immortal',
  'Legendary',
  'Epic',
  'Rare',
  'Uncommon',
  'Common',
];

/** Tolerant lookup for backend rarity strings; unknown values read as Common. */
export function rarityRgb(rarity: string): string {
  return RARITY_RGB[rarity as Rarity] ?? RARITY_RGB.Common;
}
