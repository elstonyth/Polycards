/**
 * report-duplicate-phones.ts
 *
 * "One phone number = one account" (api/utils/phone-claim.ts) is enforced
 * only in application code today — check-then-write, no lock, no unique
 * index. That file's docblock names the backstop (a partial unique index on
 * customer(phone) WHERE deleted_at IS NULL, mirroring core Medusa's
 * IDX_customer_email_has_account_unique) and names the one reason it is not
 * there yet: "live rows already share numbers, so creating it would fail
 * until those are reconciled. Dedupe, then add it." This script is that
 * first step — it names the duplicate population precisely enough for an
 * operator to act on. It does not dedupe, merge, or decide anything itself;
 * deciding which of two accounts keeps a number is a business decision with
 * money attached (balances, vault contents, VIP level, free-pack claim) and
 * belongs to the operator.
 *
 * RUN (DB reachable):
 *   corepack yarn medusa exec ./src/scripts/report-duplicate-phones.ts
 *   corepack yarn medusa exec ./src/scripts/report-duplicate-phones.ts 5
 *
 * The optional argument caps how many duplicate groups print in full. The
 * expected count is small, so omitting it prints all of them.
 *
 * READ-ONLY: no create/update/delete/upsert calls anywhere in this file. It
 * only pages customers and groups them in memory; it writes nothing.
 *
 * Phone numbers are PII, so every number this prints is masked to its last 4
 * digits (the same idiom as store/phone-verification/change/route.ts).
 * Customer ids print in full — they are opaque, and they are what an
 * operator needs in order to act. Emails are never selected from the
 * database, so they cannot appear in this output at all.
 */
import { ExecArgs } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  Modules,
} from '@medusajs/framework/utils';
import type {
  ICustomerModuleService,
  CustomerDTO,
} from '@medusajs/framework/types';

const PAGE = 500;

// Same idiom as store/phone-verification/change/route.ts. A stored value of
// 4 characters or fewer masks to itself — pre-existing edge case, not new
// disclosure here.
const mask = (phone: string): string => `••••${phone.slice(-4)}`;

// CustomerDTO#created_at is typed `Date | string` — narrow explicitly rather
// than lean on which overload the Date constructor happens to accept for a
// union argument.
const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

export default async function reportDuplicatePhones({
  container,
  args,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const customers = container.resolve<ICustomerModuleService>(
    Modules.CUSTOMER,
  );

  // Optional first arg: cap how many duplicate groups print in full. Same
  // unparseable-input guard shape as grant-skipped-challenge-cards.ts.
  const rawLimit = args?.[0];
  let groupLimit = Infinity;
  if (rawLimit !== undefined) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 0) {
      logger.error(`[report-duplicate-phones] unparseable limit: ${rawLimit}`);
      return;
    }
    groupLimit = parsed;
  }

  // Page every account with has_account: true. Soft-deleted rows are
  // excluded by listAndCountCustomers's default — deliberate here, not a gap
  // to "fix": store/customers/me/delete nulls `phone` on delete, so a
  // deleted account never holds a number. `has_account` + the soft-delete
  // default are exactly the two filters assertPhoneUnclaimed applies;
  // reproduce them here or this report stops predicting whether the unique
  // index can be created. Stable order (created_at, id) so a page boundary
  // can't skip or duplicate a row — same shape as backfill-default-group.ts.
  const rows: CustomerDTO[] = [];
  let skip = 0;
  let total = 0;
  for (;;) {
    const [page, count] = await customers.listAndCountCustomers(
      { has_account: true },
      {
        select: ['id', 'phone', 'created_at'],
        skip,
        take: PAGE,
        order: { created_at: 'ASC', id: 'ASC' },
      },
    );
    total = count;
    if (page.length === 0) break;
    rows.push(...page);
    skip += PAGE;
    if (skip >= total) break;
  }

  if (rows.length < total) {
    logger.warn(
      `[report-duplicate-phones] INCOMPLETE — scanned ${rows.length}/${total} accounts. Re-run before acting on these numbers.`,
    );
  }

  // Group by the EXACT phone string — not normalized. assertPhoneUnclaimed
  // compares exact strings and a partial unique index would enforce exact
  // strings, so this must match both or its verdict predicts a different
  // outcome from the index it exists to justify.
  //
  // Skip only a falsy phone (null or ''). A whitespace-only value is left
  // alone rather than trimmed — that is a row the index would genuinely
  // enforce on too, and normalizing it here would be the same mistake as
  // normalizing the digits.
  const groups = new Map<string, CustomerDTO[]>();
  let nonPlusCount = 0;
  for (const row of rows) {
    if (!row.phone) continue;
    if (!row.phone.startsWith('+')) nonPlusCount += 1;
    const bucket = groups.get(row.phone);
    if (bucket) bucket.push(row);
    else groups.set(row.phone, [row]);
  }

  const duplicateGroups = [...groups.entries()].filter(
    ([, g]) => g.length > 1,
  );
  const accountsInvolved = duplicateGroups.reduce(
    (sum, [, g]) => sum + g.length,
    0,
  );

  logger.info(
    `[report-duplicate-phones] accounts scanned: ${rows.length} | distinct phones: ${groups.size} | duplicate phone values: ${duplicateGroups.length} | accounts involved in duplicates: ${accountsInvolved}`,
  );

  if (nonPlusCount > 0) {
    // phone-claim.ts's docblock claims every stored phone is E.164 ("zero
    // rows store anything but `+…`", as verified against the live table when
    // it was written). A nonzero count here means that claim has drifted:
    // exact-string grouping above no longer predicts what the unique index
    // would enforce, independent of the duplicate count.
    logger.warn(
      `[report-duplicate-phones] ${nonPlusCount} account(s) have a phone NOT starting with '+' — the E.164 assumption in phone-claim.ts's docblock has drifted. Settle normalization before creating any index.`,
    );
  }

  duplicateGroups
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, groupLimit)
    .forEach(([phone, group]) => {
      // Oldest first: the oldest is the likely keeper, but that is an
      // operator's call — this only orders the list, it does not recommend.
      const oldestFirst = [...group].sort(
        (a, b) => toDate(a.created_at).getTime() - toDate(b.created_at).getTime(),
      );
      const members = oldestFirst
        .map((c) => `${c.id} (${toDate(c.created_at).toISOString()})`)
        .join(', ');
      logger.info(
        `[report-duplicate-phones]   ${mask(phone)} x${group.length}: ${members}`,
      );
    });

  if (duplicateGroups.length > groupLimit) {
    logger.info(
      `[report-duplicate-phones]   ...${duplicateGroups.length - groupLimit} more duplicate group(s) not printed (limit ${groupLimit}).`,
    );
  }

  logger.info(
    duplicateGroups.length === 0
      ? '[report-duplicate-phones] clean: the partial unique index on customer(phone) can be created'
      : `[report-duplicate-phones] ${duplicateGroups.length} phone value(s) must be reconciled first`,
  );
}
