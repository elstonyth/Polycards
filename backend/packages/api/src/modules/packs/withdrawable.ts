import { MedusaError } from '@medusajs/framework/utils';

// Playthrough withdrawal gate: money that must go through packs may not leave
// until it has been spent on them (used >= deposited). "Deposited" is every
// post-1b top-up plus every stamped sell-back — the free share of a sale from
// bonus or the welcome pull (task / challenge rewards and gift packs are not
// stamped since ADR 0012), stamped as external_funded_cents on the buyback
// row (DEPOSITED_PT_SEN_SQL). Both join the same external pool, and each open
// draws its normal (non-bonus) part from that pool first; "used" is what the
// pool covered (the open's external_funded_cents basis). Bonus spend banks
// nothing, and neither does an open made once the pool is empty (paid with
// withdrawable sell-back or commission money), so it cannot play a later
// deposit through.
//
// Spend first (2026-10-15, ADR 0013, replacing ADR 0011's partial hold):
// while anything is still to use on packs, NOTHING may leave; once it is all
// used, everything but bonus credit may. Opening a pack spends the money for
// packs before other money, so normal play clears the hold:
//   deposit 100, used 100                -> all but bonus withdrawable
//   deposit 20,  used 0                  -> nothing leaves
//   card sold for 1000, then deposit 500 -> nothing leaves until 500 is used
//
// Pure cent math, unit-tested here; walletSummary computes the same two sums
// in SQL and feeds them through this gate. The future cashout writer MUST
// route through this function before writing a 'cashout' ledger row.
export interface PlaythroughInput {
  /** Σ positive `topup` rows **with a non-NULL external basis** (post-1b era),
   *  plus each buyback's stamp (the free share of a sale, 2026-10-09), in
   *  cents. Pre-1b deposits are grandfathered: they predate
   *  `external_funded_cents` and never require playthrough (their opens' basis
   *  is equally invisible to `usedCents`, so counting them would lock them
   *  forever). */
  depositedCents: number;
  /** Σ −external_funded_cents over `pack_open` rows, in cents — what the
   *  external pool covered (0 for an open made once it was empty). Net: a
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

/** What may leave, in cents: nothing while money is still to use on packs,
 *  else the available balance less spend-only bonus (clamped at 0). */
export function withdrawableCents(t: {
  availableCents: number;
  bonusCents: number;
  remainingCents: number;
}): number {
  return t.remainingCents > 0
    ? 0
    : Math.max(0, t.availableCents - t.bonusCents);
}

/** Refusal for an account that never topped up (2026-10-11): promo credit
 *  and prizes must not leave as cash or as a shipped card from an account
 *  that never deposited. Shared by the withdrawal gate and both delivery
 *  paths; the storefront passes it through by phrase ("Top up at least once",
 *  src/lib/vault-errors.ts). */
export const NO_TOPUP_MESSAGE =
  'Top up at least once to unlock withdrawals and deliveries.';

/** The wallet fields the gate branches on (a structural subset of
 *  walletSummary's return, so either caller can pass its result straight in). */
export interface WithdrawalGateWallet {
  withdrawable: number;
  isFrozen: boolean;
  /** At least one positive top-up row ever (any era, any amount). */
  hasTopup: boolean;
  playthrough: { remaining: number };
}

/**
 * The customer-facing refusals of the withdrawal gate, in one place.
 * Returns the error to throw, or null when the amount is allowed.
 *
 * Defined HERE, and not at either call site, because the messages have exactly
 * two callers that must stay byte-identical: the authoritative gate inside
 * PacksModuleService.withdrawForCashout (under the credit: advisory lock), and
 * the pre-row precheck in gateway-withdrawal.ts. A second copy that drifted
 * would surface as a silently different refusal on one path only.
 *
 * Who matches on these strings, if you are considering a reword: the backend
 * unit tests in __tests__/gateway-withdrawal.unit.spec.ts assert them by
 * regex (both the caller-level precheck cases and the service-level gate
 * cases), AND the storefront does too — `src/lib/vault-errors.ts` passes them
 * through by phrase ("under review", "Top up at least once", "Withdrawals
 * unlock once", "you can withdraw up to") and
 * `src/app/bank-withdrawal/WithdrawForm.tsx`'s REMEDIES links them to their
 * fix. A reword that drops a phrase turns the
 * customer's refusal back into "Something went wrong" (as it was until
 * 2026-10-03). Update all of them together.
 *
 * Order matters: freeze outranks no-top-up, which outranks the money still
 * to use on packs, which outranks the plain "you can withdraw up to X" cap — a
 * frozen account must never be told it merely has packs to open.
 */
export function withdrawalGateError(
  wallet: WithdrawalGateWallet,
  amount: number,
): MedusaError | null {
  if (amount <= wallet.withdrawable) return null;
  if (wallet.isFrozen) {
    return new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Withdrawals are unavailable while your account is under review. Contact support.',
    );
  }
  if (!wallet.hasTopup) {
    return new MedusaError(MedusaError.Types.NOT_ALLOWED, NO_TOPUP_MESSAGE);
  }
  // Spend first (ADR 0013): using this money on packs really does unlock the
  // rest. In cents so a float hair can't print.
  const remainingCents = Math.round(wallet.playthrough.remaining * 100);
  if (remainingCents > 0) {
    return new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Withdrawals unlock once you've used your RM ${(remainingCents / 100).toFixed(2)} for packs. Open packs with it, then your balance can be withdrawn.`,
    );
  }
  return new MedusaError(
    MedusaError.Types.INVALID_DATA,
    `You can withdraw up to RM ${wallet.withdrawable.toFixed(2)} right now.`,
  );
}
