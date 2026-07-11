// Playthrough withdrawal gate: a balance is withdrawable only once the
// customer's lifetime pack-open spend covers their lifetime deposits
// (used >= deposited). Buyback / promo / commission credits raise the balance
// but never count as "used" — selling a card back does NOT unlock deposits
// that were never played through:
//   deposit 100, used 100            -> withdrawable
//   deposit 20,  used 0              -> locked
//   deposit 100, used 50, sold 100   -> locked (balance 150 is irrelevant)
//
// Pure cent math, unit-tested here; walletSummary computes the same two sums
// in SQL and feeds them through this gate. The future cashout writer MUST
// route through this function before writing a 'cashout' ledger row.
export interface PlaythroughInput {
  /** Σ positive `topup` rows, in cents (lifetime deposits). */
  depositedCents: number;
  /** Σ −amount over `pack_open` rows, in cents. Net: a reversed open is a
   *  positive pack_open row, so it gives its playthrough back. */
  usedCents: number;
}

export interface PlaythroughState {
  /** true once used >= deposited — the whole available balance may leave. */
  withdrawable: boolean;
  /** cents still to spend on packs before withdrawals unlock (0 when open). */
  remainingCents: number;
}

export function playthroughState(t: PlaythroughInput): PlaythroughState {
  const remainingCents = Math.max(0, t.depositedCents - t.usedCents);
  return { withdrawable: remainingCents === 0, remainingCents };
}
