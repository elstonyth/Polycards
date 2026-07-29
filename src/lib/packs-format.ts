/**
 * Shared gacha-rarity + value formatting helpers.
 *
 * Single source for the rarity tier list, the runtime rarity guard, and the USD
 * card-value formatter — used by both the pack data getters (`src/lib/data/packs.ts`)
 * and the open-pack server action (`src/lib/actions/packs.ts`) so the two can't
 * drift. Pure + isomorphic (no server-only imports), safe to import anywhere.
 */
import { priceNumber, type Rarity } from '@/lib/packs-data';
import { RARITY_ORDER } from '@/lib/rarity';
import { money } from './format';

/** Rarity tiers, rarest-first (display + iteration order).
 *  Re-exported from `@/lib/rarity` (RARITY_ORDER is the canonical source). */
export const RARITIES: readonly Rarity[] = RARITY_ORDER;

const RARITY_SET = new Set<string>(RARITIES);

/** Runtime guard: is an arbitrary string one of the known rarity tiers? */
export const isRarity = (r: string): r is Rarity => RARITY_SET.has(r);

/** Admin-PUBLISHED odds ({ overall win %, per-tier % }) — the only odds data
 *  the storefront ever shows; fully decoupled from the secret draw weights. */
export interface PublishedOdds {
  overall: number;
  tiers: Partial<Record<Rarity, number>>;
}

/** Published odds → display rows, rarest-first; only tiers given a value. */
export const publishedOddsRows = (
  po: PublishedOdds,
): { rarity: Rarity; chance: string }[] =>
  RARITIES.filter((r) => typeof po.tiers[r] === 'number').map((r) => ({
    rarity: r,
    chance: `${po.tiers[r]}%`,
  }));

/**
 * Card market value -> "RM 39.80" (MYR, always 2 decimals). Values are decimals,
 * never cents — formatted as-is.
 */
export const formatValue = (mv: number): string => money(mv, { prefix: 'RM ' });

/** Min–max of a pool's PRICED display values ('—' rows skipped); null when
 *  nothing is priced. Display prices already carry FX × per-card markup —
 *  this is a pure read, no new pricing math.
 *
 *  Only values > 0 count. The unpriced sentinel '—' parses to 0, so a card
 *  genuinely worth RM 0.00 (or a negative, which is always bad data) is dropped
 *  alongside it — deliberate: "RM 0.00 – RM 9,869.90" reads as a broken range,
 *  and the two cases are indistinguishable after priceNumber(). */
export type PoolValueRange = { min: string; max: string };

export function poolValueRange(
  pool: readonly { value: string }[],
): PoolValueRange | null {
  const values = pool.map((c) => priceNumber(c.value)).filter((v) => v > 0);
  if (values.length === 0) return null;
  return {
    min: formatValue(Math.min(...values)),
    max: formatValue(Math.max(...values)),
  };
}

/** Per-tier value ranges — the same derivation as `poolValueRange`, run over
 *  each rarity's slice of the pool, so "what is a Legendary actually worth in
 *  THIS pack" is answerable without opening the card grid. A pack-wide range
 *  alone hides that: it spans Common to Immortal and describes no tier.
 *
 *  Tiers with nothing priced are absent (not null-valued), so a caller can
 *  simply check for the key. `rarity` is typed loosely because pool rows come
 *  from the backend, where an unknown tier string must be skipped rather than
 *  crash the odds panel. */
export function tierValueRanges(
  pool: readonly { rarity: string; value: string }[],
): Partial<Record<Rarity, PoolValueRange>> {
  const byTier = new Map<string, { value: string }[]>();
  for (const card of pool) {
    if (!isRarity(card.rarity)) continue;
    const bucket = byTier.get(card.rarity);
    if (bucket) bucket.push(card);
    else byTier.set(card.rarity, [card]);
  }
  const out: Partial<Record<Rarity, PoolValueRange>> = {};
  for (const rarity of RARITIES) {
    const range = poolValueRange(byTier.get(rarity) ?? []);
    if (range) out[rarity] = range;
  }
  return out;
}
