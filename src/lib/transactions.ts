import { DEPOSIT_METHODS } from '@/lib/deposit-methods';
// Pure presentation helpers for the Transactions account page. Isomorphic (no
// server-only imports) so the server component can call them directly.
import type { CreditReason } from '@/lib/data/schemas';
import { rm } from '@/lib/format';

// Keeps its typed record over the KNOWN reason enum (exhaustiveness still
// checked for every reason the storefront knows about) — only the lookup
// below widens to accept any string.
const REASON_LABEL: Record<CreditReason, string> = {
  topup: 'Top-up',
  pack_open: 'Pack open',
  buyback: 'Sell-back',
  adjustment: 'Adjustment',
  cashout: 'Withdrawal',
  voucher_claim: 'Voucher',
  reward_credit: 'Reward credit',
  daily_reward: 'Daily reward',
  referral_commission: 'Referral commission',
  delivery_fee: 'Delivery fee',
  bonus_grant: 'Bonus credit',
};

/** Customer-facing wording for the gateway row's settlement outcome. */
export const gatewayStatusLabel = (status: string): string =>
  (
    ({
      settled: 'Confirmed by gateway',
      pending: 'Awaiting gateway',
      held: 'Awaiting approval',
      failed: 'Failed',
      expired: 'Expired',
    }) as Record<string, string>
  )[status] ?? status;

/** Channel wording, mirroring the top-up sheet's own labels. */
export const gatewayMethodLabel = (method: string): string =>
  DEPOSIT_METHODS.find((m) => m.code === method)?.label ??
  EXTRA_METHOD_LABEL[method] ??
  method;

// Rails that never appear in the top-up sheet (payouts, gateway-side codes).
const EXTRA_METHOD_LABEL: Record<string, string> = {
  FPX: 'Online banking',
  DN: 'DuitNow',
  WD: 'Bank payout',
};

// A backend reason added before the storefront redeploys has no entry in
// REASON_LABEL — prettify it generically ('refund_x' -> 'Refund x') instead
// of the row being unlabeled or dropped (audit 2026-07-07 #11).
export const reasonLabel = (reason: string): string =>
  (REASON_LABEL as Record<string, string>)[reason] ??
  reason.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** "+RM 48.00" for credits, "−RM 25.00" for spends (amount carries the sign).
 *  U+2212, not a hyphen: screen readers read it as "minus". */
export function signedRm(amount: number): string {
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
  return `${sign}${rm(Math.abs(amount))}`;
}

/** A row's move into or out of "Still to use on packs" (spec 2026-10-15 §5):
 *  "+RM 50.00 for packs" / "−RM 40.00 for packs"; null when it moved none.
 *  Rows are never marked "withdrawable" — that goes stale once spent. */
export function forPacksMark(forPacks: number): string | null {
  return Math.round(forPacks * 100) === 0
    ? null
    : `${signedRm(forPacks)} for packs`;
}

/** "Bronze Pack · Rayquaza ×3, Pikachu" — what a pack open bought or a
 *  sell-back sold, a batch open's repeats counted; null on rows with no card. */
export function cardsLine(
  packTitle: string | null,
  cardNames: string[],
): string | null {
  if (cardNames.length === 0) return null;
  const counts = new Map<string, number>();
  for (const n of cardNames) counts.set(n, (counts.get(n) ?? 0) + 1);
  const cards = [...counts]
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
    .join(', ');
  return packTitle ? `${packTitle} · ${cards}` : cards;
}

/** "RM 15.00 bonus credit" — the row's bonus part (the amount column carries
 *  the direction); null when the row has none. */
export function bonusMark(bonus: number): string | null {
  return Math.round(bonus * 100) === 0
    ? null
    : `${rm(Math.abs(bonus))} bonus credit`;
}

/**
 * "just now" / "1 minute ago" / "7 minutes ago" — how long a pending deposit
 * has been confirming.
 *
 * Minutes only, and it never says "0 minutes": the audience is someone watching
 * a payment they just made, where second-level precision reads as a stopwatch
 * on their own anxiety. `now` is passed in rather than read here so the caller
 * can stamp one instant for the whole render — the server component does
 * exactly that, which is what keeps the hydrated markup identical.
 *
 * Clamped at zero: a client clock running behind the server's would otherwise
 * render a payment as starting in the future.
 */
export function elapsedLabel(from: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - from) / 60_000);
  if (minutes < 1) return 'just now';
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
}
