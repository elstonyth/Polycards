import { RARITIES, rarityForValue, type TierRangeMap } from '@acme/odds-math';
import type { AdminCard } from './packs-api';

// Shared pieces of the two tier-range editors (the global /tier-defaults page
// and the pack editor's "Tier price ranges" section) and the two add-confirm
// call sites (cards-list bulk add, pool modal).

// Mirrors the server's MAX_TIER_BOUND_MYR (tier-settings-validate.ts) so an
// absurd bound blocks Save inline instead of dying as a 400 toast.
export const MAX_BOUND_MYR = 100_000_000;

/** One editable range row: bounds as free-typed strings ('' = open side). */
export type RangeRowState = { min: string; max: string };

export const boundText = (v: number | null | undefined): string =>
  v == null ? '' : String(v);

/** '' stays null (open bound); anything else parses as typed. */
export const parseBound = (s: string): number | null =>
  s.trim() === '' ? null : Number(s);

/** '' or a finite number in [0, MAX_BOUND_MYR]. */
export const boundOk = (s: string): boolean => {
  if (s.trim() === '') return true;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= MAX_BOUND_MYR;
};

/** Seed the editable rows (every rarity, rarest first) from a range map. */
export const seedRangeRows = (
  map: TierRangeMap,
): Record<string, RangeRowState> =>
  Object.fromEntries(
    RARITIES.map((r) => [
      r,
      { min: boundText(map[r]?.min), max: boundText(map[r]?.max) },
    ]),
  );

/**
 * Handles among `handles` whose display price fits NO configured range — the
 * set the "outside every tier price range — add anyway?" confirms are about.
 * {} ranges (feature off / fetch failed) → always empty, so callers skip the
 * prompt without their own guard.
 */
export const outsideEveryRange = (
  cards: readonly AdminCard[] | null,
  handles: readonly string[],
  ranges: TierRangeMap,
): string[] => {
  if (Object.keys(ranges).length === 0) return [];
  const byHandle = new Map((cards ?? []).map((c) => [c.handle, c]));
  return handles.filter((h) => {
    const card = byHandle.get(h);
    return (
      card !== undefined &&
      rarityForValue(card.priceBreakdown.displayPrice, ranges) === null
    );
  });
};
