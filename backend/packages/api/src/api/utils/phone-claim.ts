import { MedusaError, Modules } from '@medusajs/framework/utils';
import type {
  ICustomerModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import type { ProofClaimStore } from './rate-limit';

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
 * Soft-deleted customers are excluded (listCustomers' default) and the
 * account-deletion purge (api/utils/account-deletion.ts) nulls `phone`
 * outright, so deleting an account releases its number. Deliberate: a number
 * held hostage by a deleted row has no owner left to release it.
 *
 * The `has_account: true` filter above (and any report or index that scopes
 * to it, e.g. scripts/report-duplicate-phones.ts) is only complete if `phone`
 * is never written to a has_account: false row. TRUE for every
 * CUSTOMER-FACING write path — verified by reading each one, not assumed:
 * the only guest-customer creation path, core's findOrCreateCustomerStep
 * (@medusajs/core-flows, cart/steps/find-or-create-customer.js), creates
 * guest rows as `{ email }` only; signup's phone write forces
 * `has_account: !!authIdentityId` in the SAME core-flows transform that
 * carries the phone field (createCustomerAccountWorkflow); and this repo's
 * own phone writers — this function's callers below — act only on
 * `req.auth_context.actor_id`, and a guest customer has no session to be one.
 * (The account-deletion purge only ever writes `phone: null`, which claims
 * nothing.)
 *
 * WAS NOT true for the admin API — CLOSED 2026-08-19. `POST /admin/customers`
 * (@medusajs/medusa admin/customers/route.js) calls createCustomersWorkflow
 * DIRECTLY — not createCustomerAccountWorkflow — so nothing forced
 * has_account on that path; the customer model defaults it to `false`
 * (@medusajs/customer models/customer.js), and AdminCreateCustomer's (and
 * AdminUpdateCustomer's) Zod schema accepted a `phone` string regardless. An
 * admin caller could therefore create — or add to — a has_account: false row
 * holding a phone. No customer-create screen exists under this repo's
 * apps/admin/src, so this was a verified CODE-LEVEL exception, not a
 * confirmed data one.
 *
 * CLOSED by rejectAdminPhoneWrite (utils/phone-verification-guard.ts), which
 * refuses any request carrying a `phone` key on the body outright, on both
 * admin write verbs. Deliberately NOT routed through this function the way
 * signup is: forcing has_account true to make assertPhoneUnclaimed apply
 * would corrupt the composite index this file's index paragraph below
 * describes, and would let an admin silently claim a number away from
 * whoever really holds it, rather than refuse the write. Wired on two
 * middlewares.ts matchers: `POST /admin/customers` (create — needs its own
 * entry, since the trailing-wildcard `/admin/customers/*` matcher does not
 * reach the bare collection path) and `POST /admin/customers/*` (update —
 * closes the same hole a second way, via findOrCreateCustomerStep's
 * email-only guest rows; see the guard's own docblock for the full
 * reasoning on both).
 *
 * Either way: if a future customer-creation path sets `phone` without
 * `has_account` some other way — or rejectAdminPhoneWrite is ever unwired —
 * a has_account: true-scoped report or index stops covering the whole
 * phone-holding population with no error to say so.
 *
 * A read, so not atomic on its own. Both writers hold the number while they
 * check and write (holdPhone below, one SET NX per number in Redis): signup
 * from its check until the create has answered, phone-change around its
 * write and the second look it takes after it (putting the old number back
 * on a clash). So two signups, two changes, or a signup and a change cannot
 * both land one number, whichever proofs they carry. Not covered: the admin
 * move (POST /admin/customers/:id/phone) takes no hold, and a create still
 * running when the hold expires lets the next one in. The backstop is a
 * partial unique index
 * on customer(phone) WHERE deleted_at IS NULL, and the release-on-delete
 * behaviour above means it carries no soft-delete hazard. Core Medusa's email
 * precedent (IDX_customer_email_has_account_unique) is actually COMPOSITE —
 * `CREATE UNIQUE INDEX ... ON customer (email, has_account) WHERE deleted_at
 * IS NULL`, specifically so a guest row can share an email with a real
 * account — so a bare single-column phone index is only its equivalent
 * because of the has_account invariant above. That invariant's one known
 * exception (the admin API) is now CLOSED by rejectAdminPhoneWrite (above),
 * so a single-column index is defensible — but that defensibility rests on
 * an app-code guard staying wired on both its matchers, not on anything the
 * database itself enforces. Composite (phone, has_account), mirroring the
 * email precedent exactly, remains the option that depends on no invariant
 * at all. Whoever writes that migration should choose with that tradeoff in
 * view, not assume single-column is free. It is not here for ONE reason:
 * live rows already share numbers, so creating it would fail until those are
 * reconciled. Dedupe, then add it — `src/scripts/report-duplicate-phones.ts`
 * names the rows that have to go first.
 */
// `phone` isn't declared on FilterableCustomerProps (only has_account is) —
// same cast idiom as store/phone-verification/start/route.ts.
type CustomerFilters = Parameters<ICustomerModuleService['listCustomers']>[0];

export const PHONE_IN_USE_MESSAGE = 'This phone number is already in use.';

// shortcut: a create or change still running after this lets the next one in
// (and its late release drops that one's hold); raise it if writes get slower.
const PHONE_HOLD_MS = 60_000;

/**
 * Holds `phone` for one signup or phone change, so a concurrent one for the
 * same number cannot pass assertPhoneUnclaimed before this one's row lands.
 * Refuses a held number exactly like a claimed one, and fails CLOSED with the
 * proof claims' retryable refusal when the store errors (same store, same
 * reason: see warmSignupProofClaims). Returns the release.
 */
export const holdPhone = async (
  scope: MedusaContainer,
  claims: ProofClaimStore,
  phone: string,
): Promise<() => Promise<void>> => {
  const key = `phone-claim:${phone}`;
  const logger = scope.resolve('logger') as { warn: (msg: string) => void };
  let held: boolean;
  try {
    held = await claims.claim(key, PHONE_HOLD_MS);
  } catch (e) {
    logger.warn(
      `[phone-otp] phone claim failed (${e instanceof Error ? e.message : String(e)})`,
    );
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Could not verify your phone right now. Try again shortly.',
    );
  }
  if (!held)
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, PHONE_IN_USE_MESSAGE);
  return () =>
    claims
      .release(key)
      .catch((e) =>
        logger.warn(
          `[phone-otp] phone claim release failed (${e instanceof Error ? e.message : String(e)})`,
        ),
      );
};

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
