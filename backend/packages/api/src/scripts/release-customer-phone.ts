import { ExecArgs } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';

/**
 * Operator script: release a duplicated phone number from ONE account
 * without deleting it. Companion to delete-customer-account.ts (plan 123) —
 * that script is the right tool when an account itself should go away; this
 * one is for the narrower case where two accounts share a phone value and
 * only the number, not the account, needs to move. (Deleting the dormant
 * side of a duplicate pair was tried first and correctly refused by
 * deleteAccountPreflight when the account still held a vault card —
 * destroying an owned asset to resolve a phone collision is the wrong
 * trade.)
 *
 * DRY RUN BY DEFAULT — resolves the account, prints identity + the
 * duplicate-holder count, writes nothing:
 *   RELEASE_CUSTOMER_ID=cus_xxx RELEASE_REASON="..." corepack yarn medusa exec ./src/scripts/release-customer-phone.ts
 *
 * APPLY — CONFIRM_RELEASE must equal RELEASE_CUSTOMER_ID EXACTLY (never
 * "yes" or "1"): the guard against releasing the wrong account's number
 * after an env-var slip.
 *   RELEASE_CUSTOMER_ID=cus_xxx RELEASE_REASON="..." CONFIRM_RELEASE=cus_xxx corepack yarn medusa exec ./src/scripts/release-customer-phone.ts
 *
 * SAFETY PROPERTY this script is built around: it may only ever null a phone
 * that at least one OTHER has_account:true customer still holds. That is
 * what makes the release non-destructive and reversible without stashing
 * the number anywhere — it provably still exists on the other account. If
 * the duplicate count is zero (or cannot be determined), it refuses rather
 * than proceed. Exact-string match on `phone`, the same basis
 * report-duplicate-phones.ts and assertPhoneUnclaimed (api/utils/phone-
 * claim.ts) use, so this predicts the same grouping the pending partial
 * unique index on customer(phone) will enforce.
 *
 * Also clears customer_account_state.phone_verified_at when it is set.
 * purgeAccountPacksData (account deletion) deliberately does NOT clear that
 * stamp — a deleted account gets a `disabled` tombstone, so the stale flag
 * is unreachable behind the login block. That reasoning does not transfer
 * here: this account stays ACTIVE after the release, and the topup/delivery
 * money gates read phone_verified_at directly. Leaving it set would mark
 * the account phone-verified with no phone on file. There is no unmark
 * method on PacksModuleService (markPhoneVerified is one-way), so this
 * reads/updates customer_account_state through the same generated module
 * methods purgeAccountPacksData itself uses.
 *
 * PII: phone masked to its last 4 (same rule as the other duplicate-phone
 * scripts), email reduced to a shape hint. Neither is ever printed whole.
 */
const mask = (phone?: string | null): string =>
  phone ? `••••${phone.slice(-4)}` : '(none)';

const emailHint = (email?: string | null): string => {
  if (!email) return '(none)';
  const [local, domain] = email.split('@');
  if (!domain) return '(malformed)';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
};

const isNotFound = (error: unknown): boolean =>
  error instanceof MedusaError && error.type === MedusaError.Types.NOT_FOUND;

// `phone` isn't declared on FilterableCustomerProps (only has_account is) —
// same cast idiom as api/utils/phone-claim.ts's assertPhoneUnclaimed.
type CustomerFilters = Parameters<
  ICustomerModuleService['listAndCountCustomers']
>[0];

export default async function releaseCustomerPhone({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const customerId = process.env.RELEASE_CUSTOMER_ID?.trim();
  const reason = process.env.RELEASE_REASON?.trim();
  if (!customerId) {
    logger.error(
      '[release-customer-phone] RELEASE_CUSTOMER_ID unset — pass the id of the account giving up the number.',
    );
    return;
  }
  if (!reason) {
    logger.error(
      '[release-customer-phone] RELEASE_REASON unset — a reason is mandatory for the audit trail.',
    );
    return;
  }

  const customers = container.resolve(Modules.CUSTOMER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  // NOT_FOUND (a genuinely missing customer) is the only case that may print
  // "does not resolve" and stop cleanly. Any other failure — a DB blip, a
  // timeout — must NOT be swallowed into that same message, so it is
  // rethrown instead: an operational error must never render as a resolved
  // "nothing to do".
  const customer = await customers
    .retrieveCustomer(customerId, {
      select: ['id', 'email', 'phone', 'has_account'],
    })
    .catch((error) => {
      if (isNotFound(error)) return null;
      logger.error(
        `[release-customer-phone] lookup FAILED for ${customerId} — operational error, ` +
          `NOT a confirmed missing customer: ${(error as Error).message}`,
      );
      throw error;
    });
  if (!customer) {
    logger.error(
      `[release-customer-phone] ${customerId} does not resolve — nothing to do.`,
    );
    return;
  }

  if (!customer.phone) {
    logger.info(
      `[release-customer-phone] ${customerId} already has no phone on file — nothing to do.`,
    );
    return;
  }

  // The load-bearing safety property (see docblock): the exact SET of OTHER
  // has_account:true customers holding this phone string, not an inferred
  // count. Fetch the matching rows and filter by id — same idiom as
  // assertPhoneUnclaimed (api/utils/phone-claim.ts:
  // `matches.some((c) => c.id !== exceptCustomerId)`) — rather than
  // subtracting a count based on an assumption about whether
  // retrieveCustomer and listAndCountCustomers agree on soft-delete scoping.
  // take: 50 is a generous cap — the worst duplicate cluster observed on the
  // dev DB was 7 accounts (inspect-duplicate-phone-pair.ts's docblock) — and
  // if even that undercounts, the true count cannot be trusted, so this
  // refuses rather than guesses (ABSOLUTE: if the count cannot be
  // determined, refuse rather than proceed).
  const [holders, matchingCount] = await customers.listAndCountCustomers(
    { phone: customer.phone, has_account: true } as unknown as CustomerFilters,
    { select: ['id'], take: 50 },
  );
  if (matchingCount > holders.length) {
    logger.error(
      `[release-customer-phone] REFUSED — ${matchingCount} accounts hold ` +
        `${mask(customer.phone)}, more than could be read back to verify ` +
        `individually. The duplicate count cannot be determined safely.`,
    );
    return;
  }
  const otherHolders = holders.filter((c) => c.id !== customerId).length;

  const [accountState] = await packs.listCustomerAccountStates(
    { customer_id: customerId },
    { take: 1 },
  );

  logger.info(
    [
      `[release-customer-phone] ${customer.id}`,
      `  has_account      ${customer.has_account}`,
      `  phone            ${mask(customer.phone)}`,
      `  email            ${emailHint(customer.email)}`,
      `  other holders    ${otherHolders}`,
      `  phone_verified   ${accountState?.phone_verified_at ? 'set' : '(none)'}`,
    ].join('\n'),
  );

  if (otherHolders < 1) {
    logger.error(
      `[release-customer-phone] REFUSED — no OTHER has_account:true customer holds ` +
        `${mask(customer.phone)}. Releasing it would lose the number outright.`,
    );
    return;
  }

  const confirm = process.env.CONFIRM_RELEASE?.trim();
  if (confirm !== customerId) {
    logger.info(
      `[release-customer-phone] DRY RUN — nothing written. CONFIRM_RELEASE is ` +
        `${confirm ? `'${confirm}'` : 'unset'}; set it to '${customerId}' ` +
        `EXACTLY to release this phone.`,
    );
    return;
  }

  logger.info(
    `[release-customer-phone] CONFIRM_RELEASE matched — releasing ${customerId}'s phone.`,
  );

  await customers.updateCustomers(customerId, { phone: null });

  // Clear the verification stamp — required HERE even though
  // purgeAccountPacksData deliberately skips it on delete (see docblock).
  // Only touched when a row exists AND is actually set: absence already
  // means unverified, and this must never create a customer_account_state
  // row that didn't exist before.
  if (accountState?.phone_verified_at) {
    await packs.updateCustomerAccountStates({
      selector: { id: accountState.id },
      data: { phone_verified_at: null },
    });
  }

  // Same entity_type/action idiom as the other 'customer' + 'edit' audit
  // writers in service.ts (e.g. setPayoutDetails) — last-4/booleans only in
  // before/after, never a full phone number. admin_id names this script,
  // the same convention seed-reward-economy-demo.ts uses for a non-HTTP,
  // script-driven actor with no auth_context to derive an id from. Same
  // >4 guard as setPayoutDetails' own `last4` helper: a stored value of 4
  // characters or fewer would otherwise put the WHOLE number in the row
  // instead of a genuine fragment (report-duplicate-phones.ts calls out the
  // same short-value edge case).
  const phoneLast4 = customer.phone.length > 4 ? customer.phone.slice(-4) : null;
  await packs.createAdminActionAudits([
    {
      admin_id: 'release-customer-phone',
      entity_type: 'customer',
      entity_id: customerId,
      action: 'edit',
      before: {
        phone_last4: phoneLast4,
        phone_verified: Boolean(accountState?.phone_verified_at),
      },
      after: { phone_last4: null, phone_verified: false },
      reason,
    },
  ]);

  // Same NOT_FOUND-vs-operational split as the lookup above, but the
  // consequence differs: the release already succeeded, so a failed read
  // here is a REPORTING problem, not a reason to fail the run — it must
  // never render the same as a confirmed release, but it also must never
  // throw.
  let afterPhone: string;
  try {
    const after = await customers.retrieveCustomer(customerId, {
      select: ['id', 'phone'],
    });
    afterPhone = mask(after.phone);
  } catch (error) {
    afterPhone = isNotFound(error) ? mask(null) : '(unreadable — verify manually)';
  }
  logger.info(
    `[release-customer-phone] DONE — ${customerId} released. phone ` +
      `${mask(customer.phone)} -> ${afterPhone}`,
  );
}
