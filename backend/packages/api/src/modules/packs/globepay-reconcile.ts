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
