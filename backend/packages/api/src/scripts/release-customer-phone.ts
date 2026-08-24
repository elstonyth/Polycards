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
 * DRY RUN BY DEFAULT — resolves the account, prints identity + both
 * duplicate-holder counts, writes nothing:
 *   RELEASE_CUSTOMER_ID=cus_xxx RELEASE_REASON="..." corepack yarn medusa exec ./src/scripts/release-customer-phone.ts
 *
 * APPLY — CONFIRM_RELEASE must equal RELEASE_CUSTOMER_ID EXACTLY, byte for
 * byte (never "yes" or "1"): unlike RELEASE_CUSTOMER_ID/RELEASE_REASON
 * (both trimmed on read), CONFIRM_RELEASE is compared UNTRIMMED, so
 * surrounding whitespace from a copy-paste is a mismatch, never silently
 * forgiven — the guard against releasing the wrong account's number after
 * an env-var slip.
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
 * unique index on customer(phone) will enforce — SCOPED to has_account:true,
 * same as those two files. That scoping is deliberate and unchanged by the
 * blind-spot paragraph below: it is what makes "another account still holds
 * it" provable from one read, with no lock.
 *
 * has_account:false BLIND SPOT: the guard above, assertPhoneUnclaimed, and
 * report-duplicate-phones.ts all only ever look at has_account:true rows.
 * api/utils/phone-claim.ts's own docblock names the one historical
 * exception: POST /admin/customers used to call createCustomersWorkflow
 * directly (not createCustomerAccountWorkflow), so an admin-created row
 * could hold `phone` with has_account: false — invisible to all three
 * has_account:true-scoped checks above. That write path is now closed
 * (rejectAdminPhoneWrite, same file), but closing it does not retroactively
 * fix any row it already created, and the pending partial unique index on
 * customer(phone) is NOT scoped to has_account — so a pre-existing
 * has_account:false holder would still collide with that migration after
 * this script "succeeds" by its own has_account:true-scoped guard's
 * definition. This script therefore also takes a SECOND, separate,
 * unfiltered read (any has_account value) purely to REPORT that population
 * in the dry-run output and the final summary — it is never an input to the
 * guard above and never refuses anything by itself. If the unfiltered count
 * exceeds the has_account:true count, a warning names the gap, so the
 * operator is never left concluding "resolved" when a has_account:false
 * holder still exists.
 *
 * TOCTOU: the guard read(s) above and the write below are separate calls
 * with no lock between them — the same check-then-write shape as
 * assertPhoneUnclaimed. A real fix needs one transaction spanning
 * Modules.CUSTOMER and PACKS_MODULE, which the module boundary does not
 * allow (same limit noted under NOT ATOMIC below, for the writes
 * themselves). What this script does instead: immediately before the write,
 * it re-reads the target's own phone (aborts if it changed since the first
 * read) and re-counts the other has_account:true holders (aborts if that
 * count has dropped below 1). That shrinks the exposure from "however long
 * the operator takes to read the dry-run output and re-invoke with
 * CONFIRM_RELEASE" down to two queries' own round trip — milliseconds, on a
 * manually-run script clearing one known duplicate. Not eliminated.
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
 * NOT ATOMIC: the three writes below — customer-module phone null,
 * packs-module verification-stamp clear, packs-module audit append — are
 * three separate calls across two modules, not one transaction. The module
 * boundary does not allow spanning both in one transaction, and the plan
 * for this script forbids adding a transactional method to
 * PacksModuleService to work around it. A failure partway through is real
 * and disclosed, not hypothetical: a failure between the first write and
 * the second leaves a released phone with a STALE, still-set verification
 * stamp; a failure between either of the first two and the third leaves a
 * released phone with NO audit row, and the operator's own terminal output
 * becomes the only record of what happened and why. There is no automatic
 * recovery from a partial run — an operator reads the log and finishes the
 * remaining step(s) by hand.
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

  // Shared by the initial guard below and the pre-write TOCTOU re-check
  // further down — the exact same query both times, factored out so the two
  // call sites cannot silently drift apart (e.g. one losing the
  // has_account filter while the other keeps it).
  const holdersOf = (phone: string) =>
    customers.listAndCountCustomers(
      { phone, has_account: true } as unknown as CustomerFilters,
      { select: ['id'], take: 50 },
    );

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
  const [holders, matchingCount] = await holdersOf(customer.phone);
  if (matchingCount > holders.length) {
    logger.error(
      `[release-customer-phone] REFUSED — ${matchingCount} accounts hold ` +
        `${mask(customer.phone)}, more than could be read back to verify ` +
        `individually. The duplicate count cannot be determined safely.`,
    );
    return;
  }
  const otherHolders = holders.filter((c) => c.id !== customerId).length;

  // SECOND, separate read — reporting only, never an input to the guard
  // above (which stays has_account:true-scoped, unchanged). See the
  // has_account:false BLIND SPOT paragraph in the docblock: this is how a
  // has_account:false row holding the same phone gets surfaced to the
  // operator instead of staying invisible.
  const [, allHoldersCount] = await customers.listAndCountCustomers(
    { phone: customer.phone } as unknown as CustomerFilters,
    { select: ['id'], take: 1 },
  );
  const unscopedExtra = allHoldersCount > matchingCount;

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
      `  other holders    ${otherHolders} (has_account:true only — this is what the guard checks)`,
      `  all live holders ${allHoldersCount} (any has_account, including this account)`,
      `  phone_verified   ${accountState?.phone_verified_at ? 'set' : '(none)'}`,
    ].join('\n'),
  );
  if (unscopedExtra) {
    logger.warn(
      `[release-customer-phone] ${allHoldersCount - matchingCount} has_account:false row(s) ` +
        `also hold ${mask(customer.phone)} — the partial unique index migration will NOT be ` +
        `fully unblocked for this number by this run alone.`,
    );
  }

  if (otherHolders < 1) {
    logger.error(
      `[release-customer-phone] REFUSED — no OTHER has_account:true customer holds ` +
        `${mask(customer.phone)}. Releasing it would lose the number outright.`,
    );
    return;
  }

  // Compared UNTRIMMED — see docblock. RELEASE_CUSTOMER_ID/RELEASE_REASON
  // above are trimmed because they are free-form operator input; this one
  // is a deliberate echo-back the operator copy-pastes verbatim, so
  // whitespace slop is a signal something was copied wrong, not noise to
  // forgive.
  const confirm = process.env.CONFIRM_RELEASE;
  if (confirm !== customerId) {
    logger.info(
      `[release-customer-phone] DRY RUN — nothing written. CONFIRM_RELEASE is ` +
        `${confirm ? `'${confirm}'` : 'unset'}; set it to '${customerId}' ` +
        `EXACTLY (no surrounding whitespace) to release this phone.`,
    );
    return;
  }

  logger.info(
    `[release-customer-phone] CONFIRM_RELEASE matched — releasing ${customerId}'s phone.`,
  );

  // TOCTOU re-check, immediately before the write (see docblock). Two
  // things could have changed since the reads above: the target's own
  // phone, or the other-holder count — an operator can sit on a printed
  // dry-run for minutes before re-invoking with CONFIRM_RELEASE, and this
  // repo's release-on-delete behaviour (api/utils/account-deletion.ts nulls
  // phone on delete) means a concurrent delete of "the other holder" is
  // exactly the kind of event that could drop the count in that window.
  const recheckCustomer = await customers.retrieveCustomer(customerId, {
    select: ['id', 'phone'],
  });
  if (recheckCustomer.phone !== customer.phone) {
    logger.error(
      `[release-customer-phone] REFUSED — ${customerId}'s phone changed since the first ` +
        `read (was ${mask(customer.phone)}, now ${mask(recheckCustomer.phone)}). Re-run the script.`,
    );
    return;
  }
  const [recheckHolders] = await holdersOf(customer.phone);
  const recheckOtherHolders = recheckHolders.filter(
    (c) => c.id !== customerId,
  ).length;
  if (recheckOtherHolders < 1) {
    logger.error(
      `[release-customer-phone] REFUSED — the other-holder count for ${mask(customer.phone)} ` +
        `dropped to zero between the first read and the write. Re-run the script.`,
    );
    return;
  }

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

  // NOT_FOUND means something DIFFERENT here than at the lookup above, and
  // different from delete-customer-account.ts's post-delete read too. There,
  // NOT_FOUND on this same kind of read IS the proof of success — the whole
  // row is gone, by design. Here the write only ever nulls `phone`; it never
  // deletes the row, so the customer must still resolve afterward. A
  // NOT_FOUND at this point is an anomaly — the release write above already
  // ran, but the row is unexpectedly gone — not confirmation, and it must
  // never render as the same clean '(none)' a genuine release produces (that
  // was the bug class Sourcery flagged on the delete script twice already:
  // an alarming state must never print as a clean success). A resolved
  // non-null phone is likewise never rendered as success: mask() only
  // returns '(none)' for a null value, so a masked non-null number already
  // reads as "the release did not take" rather than being mistaken for one.
  let afterPhone: string;
  try {
    const after = await customers.retrieveCustomer(customerId, {
      select: ['id', 'phone'],
    });
    afterPhone = mask(after.phone);
  } catch (error) {
    afterPhone = isNotFound(error)
      ? '(customer row MISSING — investigate; the release write already succeeded)'
      : '(unreadable — verify manually)';
  }

  // Sourcery flagged this exact bug class a third time (PR #479): this line
  // used to say "DONE — ... released" unconditionally, so a non-'(none)'
  // afterPhone — the release not having actually taken — still read as
  // success. `released` is the single source of truth for the DONE/ANOMALY
  // word; nothing else decides it.
  const released = afterPhone === '(none)';
  const holderNote = unscopedExtra
    ? `; ${allHoldersCount - matchingCount} has_account:false row(s) also held this number`
    : '';
  logger.info(
    `[release-customer-phone] ${released ? 'DONE' : 'ANOMALY'} — ${customerId}. phone ` +
      `${mask(customer.phone)} -> ${afterPhone}. other has_account:true holders were ` +
      `${otherHolders}${holderNote}.` +
      (released
        ? ''
        : ' The release did NOT take — do not treat this phone collision as resolved.'),
  );
}
