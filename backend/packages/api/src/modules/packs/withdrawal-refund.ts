import { createHash } from 'node:crypto';
import { resolvePacks, type GatewayWithdrawals } from './facets';
import { withdrawalFeedKey } from './feed-events';
import { notifyFeed } from './notify-feed';
import { alertOps } from './ops-alert';
import { sendWithdrawalReceipt } from './withdrawal-receipt';

// The withdrawal ledger anchors and the one refund that closes a payout row.
// Below both gateway-withdrawal.ts and withdrawal-submit.ts, which re-export
// or call them, so neither imports the other.

/**
 * Idempotency anchor for the DEBIT row. Deterministic from (customer, our
 * reference) so a retried submit can never debit twice. Prefixed to stay
 * disjoint from every other anchor family in the ledger.
 */
export function withdrawalIdempotencyReference(
  customerId: string,
  merchantTransactionId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ customerId, merchantTransactionId }))
    .digest('hex');
  return `wd:${digest}`;
}

/**
 * Idempotency anchor for the REFUND row of a failed payout. Derived from the
 * same inputs but a different prefix: however many times a failure is
 * observed (submit error, callback status 5, requery status 5 — any mix),
 * exactly one refund is appended.
 */
export function withdrawalRefundReference(
  customerId: string,
  merchantTransactionId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ customerId, merchantTransactionId }))
    .digest('hex');
  return `wd-refund:${digest}`;
}

/**
 * Refund and close a withdrawal row that will never reach the bank: the
 * reconcile sweep's stale/failed rows, and the admin deny route's denied
 * rows (plan 094 Task 5). Extracted here, the module that already owns the
 * refund's idempotency anchor, so those two paths share ONE copy of this
 * four-step money ordering instead of a second verbatim one that a bug fix
 * could land in without the other ever finding out. The payout callback
 * (api/hooks/tgpay/withdrawal/route.ts) is the third caller; its settle half
 * is applyWithdrawalOutcome below, the mirror of this function.
 *
 * The caller owns two preconditions this function does not re-check:
 *   - a debit actually exists for `withdrawal` — both callers verify this
 *     themselves before calling in (see the guard above each call site). A
 *     held row is NOT exempt: the row is written 'held' at step 1 and
 *     debited at step 2, so "no debit" can mean a genuinely stranded row (a
 *     crash between the two steps) or nothing worse than reaching the guard
 *     before step 2 returned — refunding either mints money if acted on too
 *     soon. The admin routes get that distinction from
 *     packs.claimWithdrawalAgainstDebit, which reads the debit and claims the
 *     row in one transaction holding the customer's `credit:` advisory lock,
 *     so its `debited: false` means no debit will EVER land (see that
 *     method). The sweep's own call site keeps its UNLOCKED read. Not
 *     because a 'pending' row is past its debit — it is not; a
 *     below-threshold row is written 'pending' at step 1 and debited at
 *     step 2, the same two-step shape as a held one — but because of two
 *     other things. First, unknownWithdrawalAction cannot return 'refund'
 *     until the row's updated_at is older than GATEWAY_STALE_AFTER_MS (1h),
 *     so the sweep's destructive branch is unreachable inside the debit
 *     window. Second, if it ever did close a row whose debit was queued
 *     behind the `credit:` lock, withdrawForCashout's step-1a re-read now
 *     refuses to debit a closed row. Narrowed, not closed: routing the
 *     sweep through claimWithdrawalAgainstDebit with from:['pending'] is
 *     the remaining piece, tracked separately;
 *   - the row is still in `fromStatus` — the terminal update below is scoped
 *     to it and is a SILENT NO-OP otherwise, which would leave a committed
 *     refund on a row that never closes. The sweep acts on rows it selected
 *     as 'pending' (the default); the deny route claims 'failed' before
 *     calling in and passes that. Pass the status the row is ACTUALLY in at
 *     call time, not the one it started in.
 */
export async function refundWithdrawal(
  scope: { resolve: <T>(key: string) => T },
  withdrawal: {
    id: string;
    customer_id: string;
    merchant_transaction_id: string;
    gateway_transaction_id: string | null;
    amount: unknown;
    bank_code: string;
    account_number: string;
    /** The reason already on the row, if any — a row closed by the gateway
     *  or the sweep keeps it (see the terminal update below). */
    failure_reason?: string | null;
  },
  gatewayStatus: number | null,
  fromStatus: 'pending' | 'held' | 'failed' = 'pending',
  /**
   * Why this payout is being closed, stored on the row (plan 095). REQUIRED,
   * though the three callers know three different things: the admin deny route
   * knows a human said no, the sweep knows what a requery answered, and the
   * approve route knows the gateway's own codes. It was briefly optional, which
   * bought an untested "omitted leaves the column alone" branch that no caller
   * used — a closing writer with nothing to say about why is the state this
   * whole change exists to abolish, so the type refuses it.
   */
  failureReason: string,
  /** A refusal the customer is reading on screen right now: the words say
   *  it, so no receipt email and no feed row. */
  options: { customerOnScreen?: boolean } = {},
): ReturnType<GatewayWithdrawals['withdrawCreditsWithLedger']> {
  const packs = resolvePacks<GatewayWithdrawals>(scope);
  const refund = await packs.withdrawCreditsWithLedger({
    customerId: withdrawal.customer_id,
    amount: Number(withdrawal.amount),
    reason: 'cashout',
    reference:
      withdrawal.gateway_transaction_id ?? withdrawal.merchant_transaction_id,
    idempotencyReference: withdrawalRefundReference(
      withdrawal.customer_id,
      withdrawal.merchant_transaction_id,
    ),
    ledger: {
      outcome: 'refunded',
      bankCode: withdrawal.bank_code,
      accountNumber: withdrawal.account_number,
      gatewayRef:
        withdrawal.gateway_transaction_id ?? withdrawal.merchant_transaction_id,
    },
  });
  // The emailed record — after the refund commit, BEFORE the terminal row
  // update, outside any !replayed guard: once the row leaves 'pending'
  // nothing re-runs this branch, so a crash between the update and a later
  // send would lose the email forever. A crash after this send re-runs the
  // branch next sweep (the refund replays, the notification module's unique
  // idempotency_key dedupes the email). Non-throwing.
  //
  // That "next sweep retries" recovery belongs to the sweep specifically,
  // which revisits every row this branch can reach on a fixed schedule. A
  // 'held' row is never swept (nothing lists it; see the reconcile job's
  // query and its held-row regression test), so the admin deny route does
  // NOT get that retry for free: a crash in this exact window leaves the row
  // stuck short of its terminal update with a committed refund behind it,
  // and nothing automatic re-drives it. Its re-drive is a human — deny's
  // claim accepts a 'failed' row precisely so an operator can click Deny
  // again, which replays this whole sequence (the refund on its anchor, this
  // send under the notification module's idempotency key) and finishes it.
  if (!options.customerOnScreen) {
    await sendWithdrawalReceipt(scope, {
      customerId: withdrawal.customer_id,
      amount: Number(withdrawal.amount),
      // `||`, not `??` — an empty-string gateway id must fall through to the
      // merchant reference. Same reasoning as the settle branch's identical
      // choice in withdrawal-reconcile.ts; the fuller rationale lives
      // there (it explains that call site too, so it did not move with this
      // one — extracting the code must not orphan the comment from what else
      // it covers).
      reference:
        withdrawal.gateway_transaction_id || withdrawal.merchant_transaction_id,
      merchantTransactionId: withdrawal.merchant_transaction_id,
      outcome: 'refunded',
    });
  }
  const closed = await packs.updateGatewayWithdrawals({
    selector: { id: withdrawal.id, status: fromStatus },
    data: {
      status: 'failed',
      gateway_status: gatewayStatus,
      // First writer wins. The admin deny route is re-runnable on a 'failed'
      // row by design, so a mistaken Deny on a row the bank already refused
      // would otherwise replace the bank's diagnostic with "denied by admin"
      // — and the deploy's logs have rotated by then (review 2026-09). Same
      // stance as gateway_status, which deny passes back unchanged.
      ...(failureReason && !withdrawal.failure_reason
        ? { failure_reason: failureReason.slice(0, 400) }
        : {}),
    },
  });
  // The close is scoped to fromStatus. Losing it after the refund committed
  // is harmless when another refund closed the row first, but not when a
  // SUCCESS for the same payout claimed it in between (a FAIL and a SUCCESS
  // racing): the customer is then refunded AND paid, and nothing else says so.
  if (Array.isArray(closed) && closed.length === 0) {
    const [row] = await packs.listGatewayWithdrawals(
      { id: withdrawal.id },
      { take: 1 },
    );
    if (row?.status === 'settled') {
      void alertOps(
        scope,
        `refund-vs-settled:${withdrawal.merchant_transaction_id}`,
        `Payout ${withdrawal.merchant_transaction_id} (customer ${withdrawal.customer_id}) was REFUNDED RM ${Number(withdrawal.amount)}, but a success for it settled the row at the same moment. If the gateway really paid, the customer has the money twice: check the gateway's record and recover the refund by hand.`,
      );
    }
  }
  if (!refund.replayed && !options.customerOnScreen) {
    try {
      await notifyFeed(scope, {
        receiverId: withdrawal.customer_id,
        template: 'withdrawal_refunded',
        data: {
          amount_myr: Number(withdrawal.amount),
          reference:
            withdrawal.gateway_transaction_id ??
            withdrawal.merchant_transaction_id,
        },
        idempotencyKey: withdrawalFeedKey(
          withdrawal.merchant_transaction_id,
          'refunded',
        ),
      });
    } catch {
      // Never fail a committed refund over a notification.
    }
  }
  return refund;
}
