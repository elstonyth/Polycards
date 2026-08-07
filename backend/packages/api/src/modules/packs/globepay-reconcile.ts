import type { SettlementState } from './globepay';
import { GLOBEPAY_MAX_RM } from './globepay-deposit';
import { GlobePayError } from './globepay-client';

// Reconciliation policy for outstanding GlobePay365 deposits. Pure decisions,
// no container and no HTTP, so the rules are unit-testable — the job wires them
// to the gateway and the ledger.
//
// WHY this exists: their callback is fire-and-forget over the public internet.
// A dropped one means a customer paid and never got credit, permanently, with
// nothing in the system that would ever notice. Their own guidance is to
// requery rather than trust a callback, and requery is the only authoritative
// read we have.

/**
 * How long an unpaid deposit stays worth chasing. Their cashier times out in
 * 10 minutes (Merchant Detail → Time Out), so an hour is already generous;
 * beyond it the customer has almost certainly abandoned the page.
 *
 * NOT a hard truth: a bank transfer can land late, so expiry NEVER writes off a
 * deposit the gateway still considers live — expireStale only applies to rows
 * the requery itself reported as non-final.
 */
export const GLOBEPAY_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Cap per sweep. Each row costs one gateway round-trip, and the sweep runs on
 * a schedule — a backlog drains over several runs instead of hammering them in
 * one burst. Oldest first, so nothing can be starved indefinitely.
 */
export const GLOBEPAY_RECONCILE_BATCH = 50;

export type ReconcileAction =
  /** Requery says settled: credit it, exactly as a callback would have. */
  | { kind: 'settle'; amount: number }
  /** Requery says failed: close the row, no ledger write. */
  | { kind: 'fail' }
  /** Still live at the gateway: leave it alone and look again next sweep. */
  | { kind: 'wait' }
  /** Non-final AND older than the stale window: stop chasing it. */
  | { kind: 'expire' }
  /**
   * Requery says settled, but for more than the submit path could ever have
   * created. Neither credit it nor write it off — the row stays pending for an
   * operator. Deliberately NOT 'wait': the sweep must say so out loud.
   */
  | { kind: 'quarantine'; amount: number };

export type ReconcileInput = {
  state: SettlementState;
  /** Amount the gateway reports, which may differ from what we requested. */
  amount: number;
  createdAt: Date;
  now: Date;
};

/**
 * Decide what to do with one outstanding deposit after requerying it.
 *
 * The asymmetry is deliberate: 'settled' and 'failed' come straight from the
 * gateway and are final. Only the ambiguous middle — still processing, or their
 * non-final status 4 — is subject to the age cutoff, and even then expiry only
 * stops us chasing it. It never contradicts the gateway.
 */
export function reconcileAction(input: ReconcileInput): ReconcileAction {
  if (input.state === 'success') {
    // Trust the requery's amount over our requested one, for the same reason
    // the callback path does: the customer may have paid a different sum.
    //
    // Bounded by the submit path's own ceiling, though — the same guard the
    // callback route applies, for the same reason: an inflated amount from the
    // gateway converts 1:1 into withdrawable balance, and nothing downstream
    // caps a top-up. Over it we quarantine rather than settle or write off,
    // because the customer may genuinely have paid.
    if (input.amount > GLOBEPAY_MAX_RM) {
      return { kind: 'quarantine', amount: input.amount };
    }
    return { kind: 'settle', amount: input.amount };
  }
  if (input.state === 'failed') {
    return { kind: 'fail' };
  }
  const age = input.now.getTime() - input.createdAt.getTime();
  return age > GLOBEPAY_STALE_AFTER_MS ? { kind: 'expire' } : { kind: 'wait' };
}

/**
 * A deposit the gateway has never heard of (an explicit not-found requery).
 * That means SubmitDeposit never took, so no customer can ever pay it — but
 * only give up once it is old enough that an in-flight submit is impossible.
 *
 * `hasGatewayTransactionId` mirrors unknownWithdrawalAction's third argument,
 * for the same reason: globepay-deposit.ts records their D… id the moment
 * SubmitDeposit returns, so a row that carries one PROVABLY exists on their
 * side. "Never heard of it" about a transaction we can name is our own
 * configuration being broken, not non-existence — that row waits forever
 * (the job logs it loudly) instead of being written off.
 *
 * Required, not defaulting to false: a default would silently preserve the
 * unsafe reading for any caller that forgets to pass it.
 */
export function unknownDepositAction(
  createdAt: Date,
  now: Date,
  hasGatewayTransactionId: boolean,
): ReconcileAction {
  if (hasGatewayTransactionId) return { kind: 'wait' };
  return now.getTime() - createdAt.getTime() > GLOBEPAY_STALE_AFTER_MS
    ? { kind: 'expire' }
    : { kind: 'wait' };
}

/**
 * What a failed requery entitles the sweeps to do. Both sweeps used to read
 * ANY HTTP 400 as "this transaction never existed", which is the one reading
 * that loses money in both directions: a rotated key, a wrong merchant code
 * and an IP de-whitelisting all arrive as a 400 too, so one credential
 * breakage would write off every pending deposit and refund every in-flight
 * payout while the banks still executed them.
 *
 * The repo contains no signal that separates the two. Their documented
 * not-found code is PMT10016, but staging's real not-found came back as a
 * plain-text 400 WITHOUT it (docs/payments/globepay365-setup.md:124), and what
 * an auth failure returns is unrecorded (docs/ops/security-verification-
 * checklist.md item D, still open). GlobePayError.definite does not help: it
 * only says the body parsed, and a WAF page and a not-found share that shape.
 *
 * So this is deliberately conservative pending that taxonomy: only an explicit
 * not-found code authorises an action, and every other refusal we can still
 * recognise is 'ambiguous' — the caller waits and shouts. The invariant, which
 * a future "simplification" back to a bare status check would silently undo:
 * AN AMBIGUOUS REFUSAL NEVER MOVES MONEY AND NEVER CLOSES A ROW.
 */
export type RequeryRefusal =
  /** The gateway named this transaction as unknown. Actionable. */
  | { kind: 'not-found' }
  /** A refusal we cannot attribute. Wait, log, requery next sweep. */
  | { kind: 'ambiguous' }
  /** Not a gateway refusal at all (timeout, DNS, our own bug) — rethrow. */
  | { kind: 'rethrow' };

export function classifyRequeryError(error: unknown): RequeryRefusal {
  if (!(error instanceof GlobePayError)) return { kind: 'rethrow' };
  if (error.has('PMT10016')) return { kind: 'not-found' };
  return error.httpStatus === 400 ? { kind: 'ambiguous' } : { kind: 'rethrow' };
}

/**
 * How far back the second scan tier requeries 'expired' deposits. Expiry means
 * "we stopped chasing", never "the gateway said no", so a bank transfer that
 * lands late must still be recoverable — but not at the cost of a growing
 * full-table sweep, hence a window rather than "all expired rows".
 */
export const GLOBEPAY_EXPIRED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cap for that second tier, deliberately smaller than the pending batch: the
 * expired queue is a long tail of mostly-dead intent, and it must never crowd
 * out (or double) the round-trips spent on deposits a customer is waiting on.
 */
export const GLOBEPAY_EXPIRED_RETRY_BATCH = 10;

/**
 * Row shape the sweep needs; keeps the job decoupled from the model type.
 *
 * NOTE: nothing imports this today — the job reads whole model rows straight
 * from listGlobePayDeposits, so there is no select list that could omit
 * gateway_transaction_id. Left as-is rather than extended, so it cannot look
 * like the shape the sweep actually selects.
 */
export type OutstandingDeposit = {
  id: string;
  merchant_transaction_id: string;
  customer_id: string;
  created_at: Date;
};

// ---------------------------------------------------------------------------
// Withdrawal reconciliation. Same pure-decision shape, but the stakes are
// inverted: the customer's balance was ALREADY debited at submit time, so an
// outstanding withdrawal is the customer's money in limbo. The sweep never
// gives up on one — it either settles, refunds, or keeps chasing loudly.

export type WithdrawalReconcileAction =
  /** Requery says paid: close the row; the debit already happened. */
  | { kind: 'settle' }
  /** Requery says failed — or the gateway never heard of it and it is too old
   * for an in-flight submit: refund the debit (idempotent) and close. */
  | { kind: 'refund' }
  /** Still processing: leave it and look again next sweep. */
  | { kind: 'wait' };

/**
 * Decide what to do with one outstanding withdrawal after requerying it.
 * There is deliberately NO 'expire': expiring a deposit merely stops chasing
 * unpaid intent, but "expiring" a withdrawal would confiscate a debit.
 */
export function withdrawalReconcileAction(
  state: SettlementState,
): WithdrawalReconcileAction {
  if (state === 'success') return { kind: 'settle' };
  if (state === 'failed') return { kind: 'refund' };
  return { kind: 'wait' };
}

/**
 * A withdrawal the gateway CLAIMS not to know (requery 400). Two very
 * different situations produce that answer, and only one may refund:
 *
 * - No gateway id on our row: SubmitWithdrawal never returned, so either it
 *   never took or its outcome is unknown. Once the row is old enough that an
 *   in-flight submit is impossible, the debit goes back — this is the
 *   crash-recovery path the submit ordering relies on.
 * - A gateway id IS recorded: the payout PROVABLY exists on their side, so a
 *   400 requery is our own config being broken (rotated key, wrong merchant
 *   code), never non-existence. Refunding here would systematically double-
 *   pay every in-flight payout while the banks still execute them — so this
 *   path always waits, however old the row gets (the job logs it loudly).
 */
export function unknownWithdrawalAction(
  createdAt: Date,
  now: Date,
  hasGatewayTransactionId: boolean,
): WithdrawalReconcileAction {
  if (hasGatewayTransactionId) return { kind: 'wait' };
  return now.getTime() - createdAt.getTime() > GLOBEPAY_STALE_AFTER_MS
    ? { kind: 'refund' }
    : { kind: 'wait' };
}

/** Past this age a still-processing payout warrants a loud log line every
 * sweep — a payout stuck for a day is a support case, not background noise. */
export const GLOBEPAY_WD_SLOW_AFTER_MS = 24 * 60 * 60 * 1000;
