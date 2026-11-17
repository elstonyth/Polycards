import type PacksModuleService from './service';
import type { WITHDRAWAL_STATUSES } from './models/gateway-withdrawal';

type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

/**
 * The Withdrawal lifecycle: the ONLY code that writes a gateway_withdrawal
 * row after its insert. withdrawal-lifecycle-seal.unit.spec.ts fails CI on a
 * write anywhere else.
 *
 *   held ── claimHeldWithdrawal ──▶ pending (debited) | failed (never debited)
 *   pending ── settleWithdrawal ──▶ settled
 *   pending | held | failed ── failWithdrawal ──▶ failed
 *
 * Every STATUS change is a conditional claim (packs.claimWithdrawalStatus,
 * the one `UPDATE … RETURNING` in claim.ts): it answers true when THIS caller
 * moved the row, false when another writer had already moved it. Never
 * spell a status change as `updateGatewayWithdrawals({ selector, data })`.
 * That type-checks and looks like the same guard, but the generated service
 * resolves the selector with a find-then-write and takes no row lock, so two
 * racing writers both see the old status and both act.
 *
 * The non-status stamps (stampPendingWithdrawal, stampWithdrawalAudit) stay on
 * the generated updater. They write bigNumber columns (net_amount) that cannot
 * ride a raw statement (see SettlementMirror in service.ts), and they move no
 * money.
 *
 * Known writes outside this module, all non-status and all raw SQL on purpose:
 *   - the insert, startWithdrawal (gateway-withdrawal.ts), with the row's
 *     final status;
 *   - recordVerifyOutcome (api/utils/a3pay-family-hooks.ts): it must not move
 *     updated_at, which the sweep reads as the submit clock;
 *   - acknowledgeAuditFinding (service.ts): the audit_ack_* columns;
 *   - the account-number scrubs in service.ts (account deletion, bank lift).
 */

type Packs = Pick<
  PacksModuleService,
  | 'claimWithdrawalStatus'
  | 'claimWithdrawalAgainstDebit'
  | 'updateGatewayWithdrawals'
>;

/** A raw claim binds every value as given, and `undefined` is not `null`. */
const defined = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );

/**
 * An admin approve or deny of a Held Withdrawal: reads the debit and claims
 * the row in one transaction under the customer's `credit:` lock, with the
 * admin's audit row. See PacksModuleService.claimWithdrawalAgainstDebit.
 */
export function claimHeldWithdrawal(
  packs: Pick<Packs, 'claimWithdrawalAgainstDebit'>,
  input: Parameters<PacksModuleService['claimWithdrawalAgainstDebit']>[0],
): Promise<{ debited: boolean; claimed: boolean }> {
  return packs.claimWithdrawalAgainstDebit(input);
}

/** What the gateway reported about a payout it paid. `undefined` leaves a
 *  column alone; `null` clears it. */
export type WithdrawalSettlementFacts = {
  settledAt: Date;
  gatewayTransactionId?: string | null;
  gatewayStatus?: number | null;
  bankReferenceNo?: string | null;
  uniqueReferenceNo?: string | null;
  amountSettled?: number | null;
  netAmount?: number | null;
};

/**
 * pending ── settled. Only a 'pending' row can settle: a row the sweep
 * refunded a moment ago must not be flipped to 'settled' by a late callback.
 * A gateway id is written only when there is one, so an empty id never
 * erases the one on the row.
 */
export function settleWithdrawal(
  packs: Pick<Packs, 'claimWithdrawalStatus'>,
  id: string,
  facts: WithdrawalSettlementFacts,
): Promise<boolean> {
  return packs.claimWithdrawalStatus({
    id,
    from: ['pending'],
    to: 'settled',
    set: {
      settled_at: facts.settledAt,
      ...(facts.gatewayTransactionId
        ? { gateway_transaction_id: facts.gatewayTransactionId }
        : {}),
      ...defined({
        gateway_status: facts.gatewayStatus,
        bank_reference_no: facts.bankReferenceNo,
        unique_reference_no: facts.uniqueReferenceNo,
      }),
    },
    money: defined({
      amount_settled: facts.amountSettled,
      net_amount: facts.netAmount,
    }),
  });
}

/**
 * from ── failed: close a payout that will never reach the bank. False when
 * the row was no longer in any of `from`; the caller decides what that means.
 * `failureReason` is written as given (the caller keeps the first writer's
 * reason by omitting it), and is capped at the column's 400 characters.
 */
export function failWithdrawal(
  packs: Pick<Packs, 'claimWithdrawalStatus'>,
  id: string,
  close: {
    from: readonly WithdrawalStatus[];
    gatewayStatus?: number | null;
    failureReason?: string;
  },
): Promise<boolean> {
  return packs.claimWithdrawalStatus({
    id,
    from: close.from,
    to: 'failed',
    set: defined({
      gateway_status: close.gatewayStatus,
      failure_reason: close.failureReason?.slice(0, 400),
    }),
  });
}

/**
 * Stamp the gateway's id, or why it refused, on a row that is still
 * 'pending'. Scoped so a row the sweep closed while a submit was in flight
 * never gets a gateway id: that is the one shape that makes a later reader
 * believe the money went out. A silent no-op otherwise.
 */
export async function stampPendingWithdrawal(
  packs: Pick<Packs, 'updateGatewayWithdrawals'>,
  id: string,
  data: { gateway_transaction_id?: string; failure_reason?: string },
): Promise<void> {
  await packs.updateGatewayWithdrawals({
    selector: { id, status: 'pending' },
    data,
  });
}

/** Stamp the gateway audit's finding (audited_at, audit_note, a net_amount
 *  repair) on a row in any status. Never touches status. */
export async function stampWithdrawalAudit(
  packs: Pick<Packs, 'updateGatewayWithdrawals'>,
  id: string,
  data: { audited_at: Date; status?: never } & Record<string, unknown>,
): Promise<void> {
  await packs.updateGatewayWithdrawals({ id, ...data });
}
