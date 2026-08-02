import { MedusaError } from '@medusajs/framework/utils';
import { RARITIES, type TierRange, type TierRangeMap } from '@acme/odds-math';

// Bounds are RM display prices. Same absurdity ceiling as the challenge
// thresholds — prod already quotes RM 1.5M cards, so the cap only rejects
// fat-fingered magnitudes.
export const MAX_TIER_BOUND_MYR = 100_000_000;

export interface TierSettingsView {
  ranges: TierRangeMap;
}

const bad = (m: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, m);
};

// { ranges: { <rarity>: { min, max } } } → TierRangeMap. Keys must be known
// rarities; each bound null or a finite number in [0, cap]; min ≤ max when
// both set. A tier may be omitted or fully null (= unconfigured). Overlaps
// and gaps between tiers are DELIBERATELY allowed: assignment picks the
// rarest match, and a value in a gap is simply "outside every range" (that is
// what the add-confirm prompt is for).
export function validateTierRanges(raw: unknown): TierRangeMap {
  const ranges = (raw as { ranges?: unknown } | null)?.ranges;
  if (!ranges || typeof ranges !== 'object' || Array.isArray(ranges))
    bad('ranges must be an object keyed by rarity.');
  const out: TierRangeMap = {};
  for (const [key, value] of Object.entries(
    ranges as Record<string, unknown>,
  )) {
    if (!(RARITIES as readonly string[]).includes(key))
      bad(`Unknown rarity '${key}' (one of: ${RARITIES.join(', ')}).`);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      bad(`${key}: range must be an object with min/max.`);
    const r = value as Record<string, unknown>;
    const boundOf = (side: 'min' | 'max'): number | null => {
      const v = r[side] ?? null;
      if (v === null) return null;
      if (
        typeof v !== 'number' ||
        !Number.isFinite(v) ||
        v < 0 ||
        v > MAX_TIER_BOUND_MYR
      )
        bad(
          `${key}: ${side} must be null or a number 0–${MAX_TIER_BOUND_MYR}.`,
        );
      return v as number;
    };
    const range: TierRange = { min: boundOf('min'), max: boundOf('max') };
    if (range.min !== null && range.max !== null && range.min > range.max)
      bad(`${key}: min must not exceed max.`);
    out[key as (typeof RARITIES)[number]] = range;
  }
  return out;
}
