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

// Integer-sen helpers — the canonical money arithmetic for VIP math.
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

/**
 * An OPTIONAL money value read off untrusted JSON (product.metadata), where
 * "absent" and "zero" must stay distinguishable: null for null / undefined /
 * blank / non-numeric, the finite number otherwise.
 *
 * The EMPTY STRING is the load-bearing case. `Number('')` is 0 and `''` is not
 * nullish, so a `?? NaN` guard lets a blank metadata.fmv through as RM 0.00 --
 * "free" -- where it means "not recorded". Shared by the two readers of
 * product.metadata.fmv (api/admin/gacha/eligible-products and
 * modules/packs/inventory-view) so the same field cannot mean different things
 * on two screens.
 */
/**
 * What a payout cost us less what the recipient got, for the settlement
 * report's fee = gross − net rule. NULL (unknown) when either side is
 * missing — never a zero fee by omission. 2-dp inputs, 2-dp result.
 */
export function netOfFee(amount: unknown, fee: unknown): number | null {
  const a = toOptionalMoney(amount);
  const f = toOptionalMoney(fee);
  return a === null || f === null ? null : Number((a - f).toFixed(2));
}

export function toOptionalMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Whole-percent of a sen amount, staying in sen, half-up. */
export function pctOfSen(sen: number, percent: number): number {
  return Math.round((sen * percent) / 100);
}
