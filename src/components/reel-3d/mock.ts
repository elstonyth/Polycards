// Mock pool and winner picks for /reel-preview.
import type { Rarity } from '@/lib/packs-data';
import { RARITY_ORDER } from '@/lib/rarity';

export type MockCell = { dex: number; rarity: Rarity };

/** About 16 Pokémon spread over every tier in RARITY_ORDER. */
export const MOCK_POOL: readonly MockCell[] = [
  { dex: 150, rarity: 'Immortal' },
  { dex: 384, rarity: 'Immortal' },
  { dex: 249, rarity: 'Legendary' },
  { dex: 6, rarity: 'Legendary' },
  { dex: 151, rarity: 'Mythical' },
  { dex: 385, rarity: 'Mythical' },
  { dex: 149, rarity: 'Rare' },
  { dex: 448, rarity: 'Rare' },
  { dex: 130, rarity: 'Rare' },
  { dex: 25, rarity: 'Uncommon' },
  { dex: 94, rarity: 'Uncommon' },
  { dex: 143, rarity: 'Uncommon' },
  { dex: 1, rarity: 'Common' },
  { dex: 4, rarity: 'Common' },
  { dex: 7, rarity: 'Common' },
  { dex: 133, rarity: 'Common' },
];

/** Pick weights by tier: common results are frequent. */
const WEIGHT: Record<Rarity, number> = {
  Immortal: 1.5,
  Legendary: 3.5,
  Mythical: 7,
  Rare: 13,
  Uncommon: 25,
  Common: 50,
};

export const TOP_RARITY: Rarity = RARITY_ORDER[0]!;

export function pickRarity(rand: () => number): Rarity {
  const total = RARITY_ORDER.reduce((s, r) => s + WEIGHT[r], 0);
  let x = rand() * total;
  for (const r of RARITY_ORDER) {
    x -= WEIGHT[r];
    if (x <= 0) return r;
  }
  return 'Common';
}

export function cellOfRarity(rarity: Rarity, rand: () => number): MockCell {
  const of = MOCK_POOL.filter((c) => c.rarity === rarity);
  return of[Math.floor(rand() * of.length)] ?? MOCK_POOL[0]!;
}

/** One winner per reel; `forceTop` makes every reel land the top tier. */
export function pickWinners(
  count: number,
  rand: () => number,
  forceTop = false,
): MockCell[] {
  return Array.from({ length: count }, () =>
    cellOfRarity(forceTop ? TOP_RARITY : pickRarity(rand), rand),
  );
}

/** Best (highest) rarity among winners — the flood colour. */
export function bestRarity(cells: readonly { rarity: Rarity }[]): Rarity {
  return (
    RARITY_ORDER.find((r) => cells.some((c) => c.rarity === r)) ?? 'Common'
  );
}
