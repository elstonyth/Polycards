import { model } from "@medusajs/framework/utils";

// FxRate — one row per currency pair (e.g. "USD_MYR") used to convert
// PriceCharting's raw USD price for display. `rate` is the last fetched
// value; `manual_override` lets an admin pin `manual_rate` instead (e.g. the
// upstream FX source is down or wrong) without losing the fetched history.
export const FxRate = model.define("fx_rate", {
  id: model.id().primaryKey(),
  pair: model.text().unique(),
  rate: model.bigNumber(),
  source: model.text(),
  fetched_at: model.dateTime().nullable(),
  manual_override: model.boolean().default(false),
  manual_rate: model.bigNumber().nullable(),
  // SUPERSEDED 2026-10-13 by the fee percentages below and no longer read;
  // kept so a rollback still prices at the old absolute spread (RM per unit).
  markup: model.bigNumber().default(0),
  // Payment pairs only (SGD_MYR, payment-fx.ts): our fee on each direction in
  // percent of the mid (0.5 = 0.5%), and the switch that applies them. Off =
  // customers get the bare mid both ways. NULL = never configured: the rail
  // stays paused until an admin saves it. Unused on the display pair USD_MYR.
  fee_enabled: model.boolean().nullable(),
  deposit_fee_percent: model.bigNumber().default(0),
  payout_fee_percent: model.bigNumber().default(0),
});

export default FxRate;
