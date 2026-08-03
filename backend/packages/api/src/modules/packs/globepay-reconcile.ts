import type { SettlementState } from './globepay';

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
  | { kind: 'expire' };

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
    return { kind: 'settle', amount: input.amount };
  }
  if (input.state === 'failed') {
    return { kind: 'fail' };
  }
  const age = input.now.getTime() - input.createdAt.getTime();
  return age > GLOBEPAY_STALE_AFTER_MS ? { kind: 'expire' } : { kind: 'wait' };
}

/**
 * A deposit the gateway has never heard of (requery 400s with "Not found").
 * That means SubmitDeposit never took, so no customer can ever pay it — but
 * only give up once it is old enough that an in-flight submit is impossible.
 */
export function unknownDepositAction(
  createdAt: Date,
  now: Date,
): ReconcileAction {
  return now.getTime() - createdAt.getTime() > GLOBEPAY_STALE_AFTER_MS
    ? { kind: 'expire' }
    : { kind: 'wait' };
}

/** Row shape the sweep needs; keeps the job decoupled from the model type. */
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
