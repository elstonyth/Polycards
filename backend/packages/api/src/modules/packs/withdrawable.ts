// Playthrough withdrawal gate: a balance is withdrawable only once the
// customer's lifetime DEPOSIT-FUNDED pack spend covers their lifetime deposits
// (used >= deposited). "Used" counts only the deposit-funded portion of each
// open (its external_funded_cents basis) — play funded by buyback / promo /
// commission credit banks NO playthrough, so selling a card back (or spending
// non-deposit credit on packs) does NOT unlock deposits never played through:
//   deposit 100, used 100                -> withdrawable
//   deposit 20,  used 0                  -> locked
//   deposit 100, used 50, sold 100       -> locked (balance 150 is irrelevant)
//   commission 100 spent, deposit 100    -> locked (promo play banks 0 used)
//
// Pure cent math, unit-tested here; walletSummary computes the same two sums
// in SQL and feeds them through this gate. The future cashout writer MUST
// route through this function before writing a 'cashout' ledger row.
export interface PlaythroughInput {
  /** Σ positive `topup` rows **with a non-NULL external basis** (post-1b era),
   *  in cents. Pre-1b deposits are grandfathered: they predate
   *  `external_funded_cents` and never require playthrough (their opens' basis
   *  is equally invisible to `usedCents`, so counting them would lock them
   *  forever). */
  depositedCents: number;
  /** Σ −external_funded_cents over `pack_open` rows, in cents — deposit-funded
   *  spend only (0 for commission/buyback/adjustment-funded opens). Net: a
   *  reversed open's mirror row carries −originalExt, so it gives its
   *  playthrough back. */
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
