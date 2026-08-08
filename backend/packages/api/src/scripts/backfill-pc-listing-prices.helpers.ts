// Pure planner for backfill-pc-listing-prices.ts — separated so the skip/update
// decisions are unit-testable without a container (same split as
// pixel-pokemon-backfill.helpers.ts).

import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
} from '../modules/packs/pricing';

export type PcListingRow = {
  product_id: string;
  handle: string;
  /** A gacha Card exists for this handle — its price is card-managed, skip. */
  is_card: boolean;
  /** product.metadata.fmv, money-coerced; null = blank/absent/unparseable. */
  fmv_usd: number | null;
  variant_id: string | null;
  /** Current MYR listing amount on the variant; null = none found. */
  current_myr: number | null;
};

export type PcListingAction = {
  product_id: string;
  handle: string;
  variant_id: string;
  from: number | null;
  to: number;
};

export type PcListingPlan = {
  actions: PcListingAction[];
  skippedCard: number;
  skippedNoFmv: number;
  skippedNoVariant: number;
  skippedCurrent: number;
};

/**
 * Recompute every from-PC listing at FMV × fx × DEFAULT_MARKET_MULTIPLIER —
 * the exact price a fresh import produces since the +20% margin fix — and
 * plan an update for each row that differs. Idempotent by construction: a
 * second run at the same fx plans nothing.
 */
export function planPcListingPriceBackfill(
  rows: readonly PcListingRow[],
  fx: number,
): PcListingPlan {
  const plan: PcListingPlan = {
    actions: [],
    skippedCard: 0,
    skippedNoFmv: 0,
    skippedNoVariant: 0,
    skippedCurrent: 0,
  };
  for (const row of rows) {
    if (row.is_card) {
      plan.skippedCard += 1;
      continue;
    }
    if (row.fmv_usd === null) {
      plan.skippedNoFmv += 1;
      continue;
    }
    if (row.variant_id === null) {
      plan.skippedNoVariant += 1;
      continue;
    }
    const to = displayMarketPrice(row.fmv_usd, fx, DEFAULT_MARKET_MULTIPLIER);
    if (row.current_myr === to) {
      plan.skippedCurrent += 1;
      continue;
    }
    plan.actions.push({
      product_id: row.product_id,
      handle: row.handle,
      variant_id: row.variant_id,
      from: row.current_myr,
      to,
    });
  }
  return plan;
}
