import { Modules } from '@medusajs/framework/utils';
import { WITHDRAWAL_RECEIPT_TEMPLATE } from '../resend/templates';
import { receiptSiteUrl } from './topup-receipt';

// The emailed receipt for a resolved GlobePay365 payout — topup-receipt.ts's
// mirror. Two outcomes reach the customer: 'paid' (the bank transfer settled)
// and 'refunded' (the bank rejected it and the debit came back). Both carry
// the reference support quotes to the provider; neither carries the bank
// account (email is the least private channel this data could travel through).

/** Idempotency anchor, per (payout, outcome). Keyed on the SIGNED merchant
 *  reference like the feed row and the refund anchor, so a retried callback —
 *  or a callback racing the reconcile sweep — can never send a second email
 *  for one outcome. The outcome is part of the key deliberately NOT for
 *  both-outcomes-once semantics: one payout resolves to exactly one outcome
 *  (the callback route's contradiction guard enforces it), and scoping the key
 *  keeps the anchor families disjoint. */
export const withdrawalReceiptKey = (
  merchantTransactionId: string,
  outcome: 'paid' | 'refunded',
): string => `withdrawal-receipt:${outcome}:${merchantTransactionId}`;

export type WithdrawalReceiptInput = {
  customerId: string;
  amount: number;
  /** Shown to the customer and quoted to support — their W… id when we have it. */
  reference: string;
  merchantTransactionId: string;
  outcome: 'paid' | 'refunded';
  occurredAt?: Date;
};

/**
 * Send it. NEVER throws: the settle/refund is already committed when this
 * runs, and no email problem may undo money that moved. A failure is logged
 * and dropped — the customer still has the feed row, the balance, and the
 * admin Withdrawals row.
 *
 * Returns true only when a send was actually handed to the notification
 * module, so callers and tests can tell "sent" from "skipped because we had
 * no email".
 */
export async function sendWithdrawalReceipt(
  container: { resolve: (key: string) => any },
  input: WithdrawalReceiptInput,
): Promise<boolean> {
  try {
    const customers = container.resolve(Modules.CUSTOMER);
    const customer = await customers.retrieveCustomer(input.customerId);
    const email = customer?.email;
    // A guest/unlinked account with no email is not an error — there is simply
    // nowhere to send it.
    if (typeof email !== 'string' || email.length === 0) return false;

    const notifications = container.resolve(Modules.NOTIFICATION);
    await notifications.createNotifications({
      to: email,
      channel: 'email',
      template: WITHDRAWAL_RECEIPT_TEMPLATE,
      // Primitives only, and nothing secret: this payload is persisted on the
      // notification row and readable by any admin.
      data: {
        amount_myr: input.amount,
        reference: input.reference,
        outcome: input.outcome,
        occurred_at: (input.occurredAt ?? new Date()).toISOString(),
        site_url: receiptSiteUrl(),
      },
      idempotency_key: withdrawalReceiptKey(
        input.merchantTransactionId,
        input.outcome,
      ),
    });
    return true;
  } catch (error) {
    try {
      container
        .resolve('logger')
        .error(
          `[globepay] withdrawal ${input.outcome} email failed for ${input.merchantTransactionId} (the ledger is unaffected): ${(error as Error).message}`,
        );
    } catch {
      // Logger unavailable in a bare test container — swallowing is the point.
    }
    return false;
  }
}
