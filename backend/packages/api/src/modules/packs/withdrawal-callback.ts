import { resolvePacks, type GatewayWithdrawals } from './facets';
import { stampNote, withdrawalAuditNote } from './gateway-audit';
import { rowGateway, type PaymentGateway } from './gateway';
import type { SettlementState } from './gateway-types';
import {
  applyWithdrawalOutcome,
  refundWithdrawal,
  type WithdrawalSettlement,
} from './gateway-withdrawal';
import { toOptionalMoney } from './money';
import { alertOps } from './ops-alert';
import { stampWithdrawalAudit } from './withdrawal-lifecycle';

/**
 * The payout-callback state machine, shared by every gateway platform
 * (api/utils/tgpay-family-hooks.ts, api/utils/a3pay-family-hooks.ts). A
 * platform adapter verifies and decodes its own wire format into a
 * WithdrawalNotice; from there every gateway walks the same steps:
 *
 *   find the row (their id, then ours) ── none ──▶ ack, the sweep requeries
 *   another gateway's row ─────────────────────▶ ack, ignored
 *   row no longer pending ─────────────────────▶ ack; a contradiction logs,
 *                                                 alerts ops and notes the row
 *   still pending at the gateway ──────────────▶ ack
 *   failed ── refundWithdrawal ────────────────▶ ack (500 if the refund threw)
 *   success ── applyWithdrawalOutcome ─────────▶ ack
 *
 * Status changes go through the Withdrawal lifecycle, inside those two
 * helpers. The machine answers what to send; the adapter sends it, so a
 * gateway's ack bytes stay its adapter's business.
 */

type Logger = { error: (m: string) => void };

export type CallbackRow = Awaited<
  ReturnType<GatewayWithdrawals['listGatewayWithdrawals']>
>[number];

/** A verified, decoded payout callback. The row-dependent reads are
 *  functions, called only at the step that needs them, as the platforms did. */
export type WithdrawalNotice = {
  kind: PaymentGateway;
  /** Operator-facing gateway name for ops alerts. */
  label: string;
  /** Where to look, in this order. Each lookup is also scoped to `kind`. */
  find: { gatewayTransactionId?: string; merchantTransactionId?: string };
  /** The gateway's own status value, verbatim, for log lines. */
  rawStatus: string;
  state: SettlementState;
  /** Their id as this callback should report it, given the row. The
   *  row-dependent reads below are the adapter's because only it knows its
   *  units: A3Pay converts at the row's locked rate, TGPay reports RM. */
  gatewayTransactionId: (row: CallbackRow) => string;
  /** What the gateway says it paid, in ledger RM, for a contradiction note. */
  paidAmount: (row: CallbackRow) => number;
  /** Why a failed payout closed, for the row. */
  failureReason: (row: CallbackRow) => string;
  /** A settled amount that differs from what was submitted: the note (no
   *  tag) and whether it also alerts ops. */
  amountMismatch: (row: CallbackRow) => { note: string; alert: boolean } | null;
  settlement: (
    row: CallbackRow,
    gatewayTransactionId: string,
  ) => WithdrawalSettlement;
};

export type CallbackAnswer = { status: 200 | 500; body: 'success' | 'error' };

const ACK: CallbackAnswer = { status: 200, body: 'success' };

export async function handleWithdrawalCallback(
  scope: { resolve: <T>(key: string) => T },
  notice: WithdrawalNotice,
): Promise<CallbackAnswer> {
  const { kind, label, find, state, rawStatus } = notice;
  const tag = `[${kind}]`;
  const logger = scope.resolve<Logger>('logger');
  const packs = resolvePacks<GatewayWithdrawals>(scope);

  // Their id first: it is what a platform that never echoes our reference
  // sends. If the callback outruns the write that stores it, our reference is
  // the fallback. A miss after both is acknowledged and left to the payout
  // sweep, which queries by our reference.
  let withdrawal: CallbackRow | undefined;
  if (find.gatewayTransactionId) {
    [withdrawal] = await packs.listGatewayWithdrawals(
      { gateway_transaction_id: find.gatewayTransactionId, gateway: kind },
      { take: 1 },
    );
  }
  if (!withdrawal && find.merchantTransactionId) {
    [withdrawal] = await packs.listGatewayWithdrawals(
      { merchant_transaction_id: find.merchantTransactionId, gateway: kind },
      { take: 1 },
    );
  }
  if (!withdrawal) {
    logger.error(
      `${tag} verified withdrawal callback for UNKNOWN payout ${find.merchantTransactionId || find.gatewayTransactionId} (status ${rawStatus}) — nothing changed; the sweep will requery`,
    );
    return ACK;
  }
  // Belt and braces with the gateway filter on both selectors above: a row
  // that somehow answered without being this gateway's is refused, not paid.
  if (rowGateway(withdrawal) !== kind) {
    logger.error(
      `${tag} callback names payout ${withdrawal.merchant_transaction_id}, which belongs to gateway "${withdrawal.gateway}" — ignored`,
    );
    return ACK;
  }
  const merchantTransactionId = withdrawal.merchant_transaction_id;
  const gatewayTransactionId = notice.gatewayTransactionId(withdrawal);

  if (withdrawal.status !== 'pending') {
    const contradicts =
      (state === 'success' && withdrawal.status !== 'settled') ||
      (state === 'failed' && withdrawal.status !== 'failed');
    if (contradicts) {
      logger.error(
        `${tag} withdrawal ${merchantTransactionId} callback says ${rawStatus} (${state}) but the row is already ${withdrawal.status} — possible double payment, investigate (gateway ${gatewayTransactionId})`,
      );
      // A log line alone is read only when someone already suspects a problem;
      // a paid-after-refund payout is real money gone twice. References only.
      void alertOps(
        scope,
        'payout-contradiction',
        `${label} says payout ${merchantTransactionId} is ${state}, but our row is already ${withdrawal.status}` +
          (state === 'success'
            ? ' — the customer may have been refunded AND paid.'
            : '.') +
          ` Investigate ${label} ${gatewayTransactionId}.`,
      );
      // On the row too, in the audit's own words, so the Settlement page and
      // the Dashboard show it at once instead of at the next audit: the ops
      // alert alone reaches nobody until its chat is set up (2026-10-15).
      // Best-effort: the gateway still gets its 200 either way.
      try {
        const paid = notice.paidAmount(withdrawal);
        await stampWithdrawalAudit(packs, withdrawal.id, {
          audited_at: new Date(),
          ...stampNote(
            withdrawal,
            withdrawalAuditNote(
              {
                status: withdrawal.status,
                amount: toOptionalMoney(withdrawal.amount),
              },
              {
                kind: 'detail',
                state,
                amount: Number.isFinite(paid)
                  ? paid
                  : Number(withdrawal.amount),
              },
            ),
          ),
        });
      } catch (error) {
        logger.error(
          `${tag} could not record the contradiction on ${merchantTransactionId}: ${(error as Error).message}`,
        );
      }
    }
    return ACK;
  }

  if (state === 'pending') return ACK;

  if (state === 'failed') {
    try {
      await refundWithdrawal(
        scope,
        withdrawal,
        null,
        'pending',
        notice.failureReason(withdrawal),
      );
    } catch (error) {
      logger.error(
        `${tag} failed to refund withdrawal ${merchantTransactionId}: ${(error as Error).message}`,
      );
      return { status: 500, body: 'error' };
    }
    return ACK;
  }

  const mismatch = notice.amountMismatch(withdrawal);
  if (mismatch) {
    logger.error(`${tag} ${mismatch.note}`);
    // Money left in a different amount than we debited for: someone must
    // look, and a log line is read only by someone already suspicious.
    if (mismatch.alert) void alertOps(scope, 'payout-contradiction', mismatch.note);
  }

  // Receipt -> claim -> feed, shared with the payout sweep.
  await applyWithdrawalOutcome(
    scope,
    withdrawal,
    notice.settlement(withdrawal, gatewayTransactionId),
  );
  return ACK;
}
