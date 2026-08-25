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
  cashout: 'Cashout',
  voucher_claim: 'Voucher',
  reward_credit: 'Reward credit',
  daily_reward: 'Daily reward',
};

// A backend reason added before the storefront redeploys has no entry in
// REASON_LABEL — prettify it generically ('refund_x' -> 'Refund x') instead
// of the row being unlabeled or dropped (audit 2026-07-07 #11).
export const reasonLabel = (reason: string): string =>
  (REASON_LABEL as Record<string, string>)[reason] ??
  reason.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** "+RM 48.00" for credits, "-RM 25.00" for spends (amount carries the sign). */
export function signedRm(amount: number): string {
  const sign = amount > 0 ? '+' : amount < 0 ? '-' : '';
  return `${sign}${rm(Math.abs(amount))}`;
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
