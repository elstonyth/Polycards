import type {
  INotificationModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';
import { isResendConfigured } from '../../modules/resend/options';
import { PHONE_CHANGED_TEMPLATE } from '../../modules/resend/templates';

// Last 4 digits only. The masked pair rides an email body and a persisted
// notification row (GET /admin/notifications exposes `data` to any admin —
// the same surface subscribers/password-reset.ts documents as accepted risk),
// so the full number must never appear there.
//
// A number that passed E164_RE (>= 7 digits after the '+') always loses
// something to slice(-4). A legacy stored value of 4 characters or fewer masks
// to itself — the pre-existing value echoed back to its own owner's inbox, not
// a new disclosure, but do not read this as a length guarantee.
export const maskPhone = (phone: string): string => `••••${phone.slice(-4)}`;

/**
 * Tell an account its recovery phone moved — shared by the customer's own
 * change (store/phone-verification/change) and customer service's
 * (admin/customers/:id/phone). Sent to the EMAIL, never to either number:
 * email is the one channel someone who has just taken the phone has not taken.
 *
 * Best-effort and NEVER throws: the phone change is already persisted, so a
 * failure here must not report failure for something that succeeded. Skipped
 * when Resend is not configured — the same predicate medusa-config.ts registers
 * the provider on, so dev does not warn on every change.
 *
 * PRIVACY: the warn names the customer id only. The provider's own error text
 * is NOT interpolated — it names the failed recipient, which would put the
 * email address in the logs through the back door.
 */
export async function sendPhoneChangedNotice(
  scope: MedusaContainer,
  input: {
    to: string;
    customerId: string;
    /** null when the account had no number before (an admin first-add). */
    oldPhone: string | null;
    newPhone: string;
    /** Log prefix naming the caller, e.g. 'phone-change'. */
    logTag: string;
  },
): Promise<void> {
  try {
    if (!isResendConfigured(process.env)) return;
    const notifications = scope.resolve<INotificationModuleService>(
      Modules.NOTIFICATION,
    );
    await notifications.createNotifications({
      to: input.to,
      channel: 'email',
      template: PHONE_CHANGED_TEMPLATE,
      data: {
        old_phone_masked: input.oldPhone
          ? maskPhone(input.oldPhone)
          : 'no number',
        new_phone_masked: maskPhone(input.newPhone),
      },
    });
  } catch {
    scope
      .resolve<{ warn: (msg: string) => void }>('logger')
      .warn(
        `[${input.logTag}] could not email the change notice for customer ${input.customerId} — phone already updated`,
      );
  }
}
