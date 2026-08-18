import { MedusaError, Modules } from '@medusajs/framework/utils';
import type {
  ICustomerModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';

/**
 * One phone number = one account.
 *
 * The OTP proof only establishes that the CALLER can receive SMS at a number —
 * it says nothing about whether another account already owns it. This is the
 * one place that answers that, for every path that binds a phone to a customer:
 * signup (utils/phone-verification-guard.ts + the check route's 'signup'
 * purpose) and phone-change (store/phone-verification/change).
 *
 * Exact string match, because every write path normalizes to E.164 before it
 * gets here (storefront normalizePhone, E164_RE on both OTP routes) — verified
 * against the live customer table: zero rows store anything but `+…`.
 *
 * Soft-deleted customers are excluded (listCustomers' default) and
 * store/customers/me/delete nulls `phone` outright, so deleting an account
 * releases its number. Deliberate: a number held hostage by a deleted row has
 * no owner left to release it.
 *
 * NOT atomic — check-then-write, no lock or unique index. State the real
 * exposure rather than the change route's old one: at SIGNUP a proof token is
 * purpose-scoped but not single-use, so one person with one handset can fire
 * two concurrent POST /store/customers inside the proof's 10-minute window and
 * have both reads see zero claimants. The backstop is a partial unique index
 * on customer(phone) WHERE deleted_at IS NULL — core Medusa already ships
 * exactly that shape for email (IDX_customer_email_has_account_unique), and
 * the release-on-delete behaviour above means it carries no soft-delete
 * hazard. It is not here for ONE reason: live rows already share numbers, so
 * creating it would fail until those are reconciled. Dedupe, then add it —
 * `src/scripts/report-duplicate-phones.ts` names the rows that have to go
 * first.
 */
// `phone` isn't declared on FilterableCustomerProps (only has_account is) —
// same cast idiom as store/phone-verification/start/route.ts.
type CustomerFilters = Parameters<ICustomerModuleService['listCustomers']>[0];

export const PHONE_IN_USE_MESSAGE = 'This phone number is already in use.';

export const assertPhoneUnclaimed = async (
  scope: MedusaContainer,
  phone: string,
  /** The caller's own customer id on a CHANGE — their existing row is not a clash. */
  exceptCustomerId?: string,
): Promise<void> => {
  const customers = scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const matches = await customers.listCustomers(
    { phone, has_account: true } as unknown as CustomerFilters,
    { select: ['id'], take: 2 },
  );
  if (matches.some((c) => c.id !== exceptCustomerId))
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, PHONE_IN_USE_MESSAGE);
};
