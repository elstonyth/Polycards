// The single coercion from a stored money value (Medusa numeric column →
// BigNumber | numeric string | number) to a JSON-safe JS number. The param is
// `unknown` because a DB money value genuinely arrives untyped; the body is
// exactly `Number(value)`, so this is a behavior-preserving, centralized
// replacement for the ~15 inline `Number(card.market_value)` / `Number(pack.price)`
// call sites. 2dp money decimals, never cents/sen. (Ledger/pack money is RM;
// only raw PriceCharting FMV values are USD.)
export function toMoney(value: unknown): number {
  return Number(value);
}

// Integer-sen helpers — the canonical money arithmetic for VIP/commission math.
// Mirrors the existing Math.round(x*100) integer-cent pattern (buyback-rate.ts,
// credit-summary.ts) so a single place pins the rounding rule. Money is 2dp at the
// boundary; compute in sen to avoid float drift.

/**
 * USD/MYR decimal (number | numeric string | BigNumber) -> integer sen.
 * Rounds half away from zero so negatives are symmetric (Math.round alone sends
 * -0.5 toward +inf), matching Postgres ROUND(amount * 100) used by the ledger.
 */
export function toSen(value: unknown): number {
  const scaled = Number(value) * 100;
  return scaled >= 0 ? Math.round(scaled) : -Math.round(-scaled);
}

/** Integer sen -> 2dp decimal. */
export function fromSen(sen: number): number {
  return sen / 100;
}

/** Whole-percent of a sen amount, staying in sen, half-up. */
export function pctOfSen(sen: number, percent: number): number {
  return Math.round((sen * percent) / 100);
}
