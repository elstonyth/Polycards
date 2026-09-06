import { Modules } from '@medusajs/framework/utils';
import { TOPUP_RECEIPT_TEMPLATE } from '../resend/templates';

// The emailed receipt for a settled GlobePay365 top-up. Sits beside notifyFeed
// (the in-app bell row): the feed tells them while they are on the site, this
// reaches them when they are not, and it is the artefact they keep.
//
// Deliberately its own module rather than part of notify-feed.ts — that file is
// about the customer_feed channel, this is email, and the failure rules differ:
// a feed row is cosmetic, an email is a durable record that support quotes back.

/** Where the customer lands from the email. Production defines BOTH names; the
 *  literal is the last resort so a missing var can never produce a localhost
 *  link in a real receipt (the trap STOREFRONT_URL fell into once already). */
export function receiptSiteUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.STOREFRONT_URL ||
    env.MERCUR_STOREFRONT_URL ||
    'https://polycards.gg'
  ).replace(/\/+$/, '');
}

/** Idempotency anchor. Keyed on the SIGNED merchant reference, the same anchor
 *  family as the credit and the feed row, so a retried callback — or a callback
 *  racing the reconcile sweep — can never send a second receipt for one
 *  payment. */
export const topupReceiptKey = (merchantTransactionId: string): string =>
  `topup-receipt:${merchantTransactionId}`;

export type TopupReceiptInput = {
  customerId: string;
  amount: number;
  /** Shown to the customer and quoted to support — their id when we have it. */
  reference: string;
  merchantTransactionId: string;
  paymentMethodCode: string;
  settledAt?: Date;
};

/**
 * Send it. NEVER throws: the credit is already committed when this runs, and no
 * email problem may undo money that landed. A failure is logged and dropped —
 * the customer still has the balance, the feed row, and the admin Deposits row.
 *
 * Returns true only when a send was actually handed to the notification module,
 * so callers and tests can tell "sent" from "skipped because we had no email".
 */
export async function sendTopupReceipt(
  container: { resolve: (key: string) => any },
  input: TopupReceiptInput,
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
      template: TOPUP_RECEIPT_TEMPLATE,
      // Primitives only, and nothing secret: this payload is persisted on the
      // notification row and readable by any admin.
      data: {
        amount_myr: input.amount,
        reference: input.reference,
        payment_method: input.paymentMethodCode,
        occurred_at: (input.settledAt ?? new Date()).toISOString(),
        site_url: receiptSiteUrl(),
      },
      idempotency_key: topupReceiptKey(input.merchantTransactionId),
    });
    return true;
  } catch (error) {
    try {
      container
        .resolve('logger')
        .error(
          `[payments] receipt email failed for ${input.merchantTransactionId} (credit is unaffected): ${(error as Error).message}`,
        );
    } catch {
      // Logger unavailable in a bare test container — swallowing is the point.
    }
    return false;
  }
}
