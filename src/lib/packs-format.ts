/**
 * Shared gacha-rarity + value formatting helpers.
 *
 * Single source for the rarity tier list, the runtime rarity guard, and the USD
 * card-value formatter — used by both the pack data getters (`src/lib/data/packs.ts`)
 * and the open-pack server action (`src/lib/actions/packs.ts`) so the two can't
 * drift. Pure + isomorphic (no server-only imports), safe to import anywhere.
 */
import type { Rarity } from "@/app/claw/packs-data";

/** Canonical rarity tiers, rarest-first (display + iteration order). */
export const RARITIES: Rarity[] = [
  "Legendary",
  "Epic",
  "Rare",
  "Uncommon",
  "Common",
];

const RARITY_SET = new Set<string>(RARITIES);

/** Runtime guard: is an arbitrary string one of the known rarity tiers? */
export const isRarity = (r: string): r is Rarity => RARITY_SET.has(r);

/**
 * Card market value -> "$39.80" (USD, always 2 decimals). Values are decimals,
 * never cents — formatted as-is.
 */
export const formatValue = (mv: number): string =>
  `$${mv.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
