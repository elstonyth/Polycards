import { Modules } from '@medusajs/framework/utils';
import { BANK_ACCOUNT_ADDED_TEMPLATE } from '../resend/templates';
import { notifyFeedNonfatal } from './notify-feed';
import { receiptSiteUrl } from './topup-receipt';
import { payoutDestinationCooldownHours } from './saved-accounts';

// "A new payout destination was added to your account" — email + in-app feed
// row. Shaped like sendTopupReceipt (its neighbour), for the same reason: the
// feed reaches them on the site, the email reaches them when they are not on it.
//
// This one is a SECURITY notice rather than a receipt. It is the control that
// makes the cooling-off window worth having: an attacker holding a stolen token
// can add a destination, but they cannot spend the day it takes to arm without
// the real owner getting an email about a bank account they do not recognise.
// So it must survive being useless-looking — never include the full account
// number (last 4 only, same rule the WD ledger payload follows), and never
// throw.

/**
 * Idempotency anchor. Keyed on the customer, the saved account's id AND the
 * instant it was saved.
 *
 * `savedAt` is in there deliberately, and dropping it re-opens the hole this
 * whole notice exists to close: an attacker whose first attempt was noticed and
 * deleted could re-add the SAME destination — a fresh entry with a fresh
 * cooling-off window — and a key without `savedAt` would match the alert
 * already sent, so the owner would never hear about the second attempt.
 *
 * Retried POSTs are not what this guards: the route only calls the notice when
 * the account was genuinely appended, and a re-save of an existing entry takes
 * the update-in-place branch and stays silent.
 */
export const savedAccountNoticeKey = (
  customerId: string,
  accountId: string,
  savedAt: string,
): string => `bank-account-added:${customerId}:${accountId}:${savedAt}`;

export type SavedAccountAddedInput = {
  customerId: string;
  /** The saved account's deterministic id — the idempotency anchor. */
  accountId: string;
  bankName: string;
  /** Full number in, last 4 out — nothing here forwards the whole thing. */
  accountNumber: string;
  /** ISO instant the account was saved; the notice quotes when it arms. */
  savedAt: string;
};

/**
 * Send it. NEVER throws: the account is already saved when this runs, and no
 * notification problem may undo that. Returns true only when an email was
 * actually handed to the notification module, so tests can tell "sent" from
 * "skipped because we had no email".
 */
export async function sendSavedAccountAddedNotice(
  container: { resolve: (key: string) => any },
  input: SavedAccountAddedInput,
): Promise<boolean> {
  const last4 = input.accountNumber.slice(-4);
  const key = savedAccountNoticeKey(
    input.customerId,
    input.accountId,
    input.savedAt,
  );
  const usableFrom = new Date(
    new Date(input.savedAt).getTime() +
      payoutDestinationCooldownHours() * 60 * 60 * 1000,
  ).toISOString();

  await notifyFeedNonfatal(container, 'saved-account-added', {
    receiverId: input.customerId,
    template: 'bank_account_added',
    data: {
      bank_name: input.bankName,
      account_last4: last4,
      usable_from: usableFrom,
    },
    idempotencyKey: `feed:${key}`,
  });

  try {
    const customers = container.resolve(Modules.CUSTOMER);
    const customer = await customers.retrieveCustomer(input.customerId);
    const email = customer?.email;
    // No email on the account is not an error — there is nowhere to send it.
    if (typeof email !== 'string' || email.length === 0) return false;

    const notifications = container.resolve(Modules.NOTIFICATION);
    await notifications.createNotifications({
      to: email,
      channel: 'email',
      template: BANK_ACCOUNT_ADDED_TEMPLATE,
      // Primitives only, and nothing secret: this payload is persisted on the
      // notification row and readable by any admin.
      data: {
        bank_name: input.bankName,
        account_last4: last4,
        usable_from: usableFrom,
        site_url: receiptSiteUrl(),
      },
      idempotency_key: `email:${key}`,
    });
    return true;
  } catch (error) {
    try {
      container
        .resolve('logger')
        .error(
          `[saved-account-added] alert email failed for customer ${input.customerId} (the account is saved regardless): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
    } catch {
      // Logger unavailable in a bare test container — swallowing is the point.
    }
    return false;
  }
}
