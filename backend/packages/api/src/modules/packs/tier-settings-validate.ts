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

// Bare { <rarity>: { min, max } } map → TierRangeMap. Keys must be known
// rarities; each bound null or a finite number in [0, cap]; min ≤ max when
// both set. A tier may be omitted or fully null (= unconfigured). Overlaps
// and gaps between tiers are DELIBERATELY allowed: assignment picks the
// rarest match, and a value in a gap is simply "outside every range" (that is
// what the add-confirm prompt is for). Shared by the global tier_settings
// singleton and the per-pack pack.tier_ranges override.
export function validateTierRangeMap(raw: unknown): TierRangeMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    bad('ranges must be an object keyed by rarity.');
  const out: TierRangeMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
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

// { ranges: {...} } request body → TierRangeMap (the tier_settings POST shape).
export function validateTierRanges(raw: unknown): TierRangeMap {
  return validateTierRangeMap((raw as { ranges?: unknown } | null)?.ranges);
}

// Sparse map → a full-key write shape: EVERY rarity present, null for the
// unconfigured ones. The ORM MERGES json POJOs on update (an omitted key
// survives a "replace"), so any UPDATE of a ranges column must write all six
// keys or a removed tier silently resurrects. Reads normalize the nulls back
// out. Shared by editTierSettings and the pack tier_ranges update step.
export function fillTierRanges(
  map: TierRangeMap,
): Record<string, TierRange | null> {
  const full: Record<string, TierRange | null> = {};
  for (const rarity of RARITIES) full[rarity] = map[rarity] ?? null;
  return full;
}

// Stored jsonb → the usable TierRangeMap: EVERY rarity key may be present
// (null = unconfigured — see editTierSettings); reads drop nulls and
// non-numeric noise so consumers only ever see ranges they can act on.
export function normalizeTierRanges(stored: unknown): TierRangeMap {
  const map = (stored ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const ranges: TierRangeMap = {};
  for (const rarity of RARITIES) {
    const r = map[rarity];
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const range: TierRange = {
      min: num((r as Record<string, unknown>).min),
      max: num((r as Record<string, unknown>).max),
    };
    if (range.min === null && range.max === null) continue;
    ranges[rarity] = range;
  }
  return ranges;
}
