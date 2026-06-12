/**
 * Guest demo-spin draw — pure theater for logged-out visitors.
 *
 * Samples a rarity from the STATIC published odds (the `ODDS` display in
 * packs-data.ts — by design decoupled from the backend's secret per-card
 * weights) and picks a card of that tier from the public pool. Runs entirely
 * client-side: no backend call, no Pull row, no credit/stock effects.
 * `Math.random` quality is fine here — nothing real is at stake.
 *
 * Rolls are injected as arguments so the weighting math stays unit-testable.
 */
import type { PackCard, Rarity } from "@/app/claw/packs-data";

export interface PublishedOdd {
  rarity: Rarity;
  /** Published percentage, e.g. "0.5%". */
  chance: string;
}

/** "0.5%" → 0.5; malformed input → 0 (the tier just never gets sampled). */
export function parseChance(chance: string): number {
  const n = Number.parseFloat(chance);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Weighted rarity sample. `roll` ∈ [0,1) walks the cumulative published
 * chances in display order (rarest first); degenerate rolls (≥ total weight)
 * resolve to the last — most common — tier.
 */
export function sampleRarity(odds: PublishedOdd[], roll: number): Rarity {
  const total = odds.reduce((sum, o) => sum + parseChance(o.chance), 0);
  let cursor = roll * total;
  for (const o of odds) {
    cursor -= parseChance(o.chance);
    if (cursor < 0) return o.rarity;
  }
  return odds[odds.length - 1].rarity;
}

/**
 * Draw a demo card: sample a tier (`rarityRoll`), then pick uniformly within
 * it (`cardRoll`). A pool may not stock every published tier — fall back to
 * the nearest MORE COMMON tier first (cheaper-feeling miss beats a windfall),
 * then rarer ones. Returns null only for an empty pool.
 */
export function demoDraw(
  pool: PackCard[],
  odds: PublishedOdd[],
  rarityRoll: number,
  cardRoll: number,
): PackCard | null {
  if (pool.length === 0) return null;

  const target = sampleRarity(odds, rarityRoll);
  const order = odds.map((o) => o.rarity);
  const start = order.indexOf(target);
  const candidates = [
    ...order.slice(start), // target, then more common
    ...order.slice(0, start).reverse(), // then rarer, nearest first
  ];

  for (const rarity of candidates) {
    const tier = pool.filter((c) => c.rarity === rarity);
    if (tier.length > 0) {
      return tier[
        Math.min(tier.length - 1, Math.floor(cardRoll * tier.length))
      ];
    }
  }
  // Pool rarities all outside the published odds (can't happen with the full
  // static ODDS, but keeps the "null only on empty pool" contract honest).
  return pool[0];
}
