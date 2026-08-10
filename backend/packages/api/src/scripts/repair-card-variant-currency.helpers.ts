// Pure planner for repair-card-variant-currency.ts — separated so the
// skip/repair decisions are unit-testable without a container (same split as
// backfill-pc-listing-prices.helpers.ts).

import { displayMarketPrice } from '../modules/packs/pricing';

export type CardVariantRow = {
  product_id: string;
  handle: string;
  variant_id: string | null;
  /** The variant already carries a MYR price row — healthy, skip. */
  has_myr: boolean;
  /** Card.price (MYR sentinel; null = "use FMV"). */
  card_price_myr: number | null;
  /** Card.market_value — raw USD. */
  market_value_usd: number;
  /** Card.market_multiplier (already defaulted by the caller). */
  market_multiplier: number;
};

export type CardVariantAction = {
  product_id: string;
  handle: string;
  variant_id: string;
  to: number;
};

export type CardVariantPlan = {
  actions: CardVariantAction[];
  skippedHealthy: number;
  skippedNoVariant: number;
};

/**
 * Plan a MYR price for every card variant the pre-fix edit path left usd-only
 * (update-card used to REPLACE the price set with a single 'usd' row). The
 * restored amount is what the fixed edit path writes: the card's stored MYR
 * price, or the FMV-derived display price (FMV × fx × the card's multiplier).
 * Variants that still have a myr row are healthy and never touched.
 * updatePriceSets' replace-the-set semantics then also drop the stray usd row.
 */
export function planCardVariantCurrencyRepair(
  rows: readonly CardVariantRow[],
  fx: number,
): CardVariantPlan {
  const plan: CardVariantPlan = {
    actions: [],
    skippedHealthy: 0,
    skippedNoVariant: 0,
  };
  for (const row of rows) {
    if (row.variant_id === null) {
      plan.skippedNoVariant += 1;
      continue;
    }
    if (row.has_myr) {
      plan.skippedHealthy += 1;
      continue;
    }
    plan.actions.push({
      product_id: row.product_id,
      handle: row.handle,
      variant_id: row.variant_id,
      to:
        row.card_price_myr ??
        displayMarketPrice(row.market_value_usd, fx, row.market_multiplier),
    });
  }
  return plan;
}
