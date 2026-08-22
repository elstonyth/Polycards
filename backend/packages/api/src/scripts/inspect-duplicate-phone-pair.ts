import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';

/**
 * READ-ONLY companion to report-duplicate-phones.ts.
 *
 * That report says WHICH phone values are duplicated; this one says which of
 * the accounts sharing a value is the real one, so an operator can decide what
 * to reconcile without guessing. It performs NO writes — the only calls are
 * `retrieveCustomer`, `list*`/`listAndCount*`, and `creditBalance` (a
 * SELECT-only SQL aggregate) reads.
 *
 * Ids come from the report's own output and are passed in, never discovered
 * here, so this can only ever look at accounts an operator already chose.
 * That's two or more ids, NOT always a strict pair — the report can surface a
 * phone shared by more than two accounts (a 7-account cluster was observed on
 * the dev DB), and this must be able to walk the whole cluster:
 *
 *   DUP_IDS=cus_a,cus_b[,cus_c,...] medusa exec ./src/scripts/inspect-duplicate-phone-pair.ts
 *
 * PII: the phone is masked to its last 4 (same rule as the report) and the
 * email is reduced to a shape hint (first char + domain), never printed whole.
 * That is enough to tell repeat signups by the same human from different
 * humans who coincidentally share a number, which is the decision this
 * exists to support.
 *
 * Every per-customer field degrades independently instead of aborting the
 * whole report: activity reads (pulls/credit/deposits) catch their own
 * errors, and PACKS_MODULE itself is resolved defensively below, so a
 * missing module still lets every customer's identity fields print with
 * 'n/a' activity rather than throwing before the first line is logged.
 */
const mask = (phone?: string | null): string =>
  phone ? `••••${phone.slice(-4)}` : '(none)';

const emailHint = (email?: string | null): string => {
  if (!email) return '(none)';
  const [local, domain] = email.split('@');
  if (!domain) return '(malformed)';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
};

type ActivitySummary = {
  pullCount: string;
  lastPull: string;
  balance: string;
  deposits: string;
};

const NO_ACTIVITY: ActivitySummary = {
  pullCount: 'n/a',
  lastPull: 'n/a',
  balance: 'n/a',
  deposits: 'n/a',
};

/**
 * Per-customer activity signals for one account. Every read is independent
 * and degrades to 'n/a' on its own rather than aborting the whole report.
 *
 * Counts/sums come from listAndCount* methods and creditBalance (exact,
 * DB-side), never a capped `take` presented as if it were a full total — a
 * fixed cap here previously let a truncated count or balance print as
 * complete, which is exactly the wrong failure mode for a tool an operator
 * uses to pick which account is real.
 */
async function readActivity(
  svc: PacksModuleService,
  customerId: string,
): Promise<ActivitySummary> {
  let pullCount = 'n/a';
  let lastPull = 'n/a';
  try {
    // take: 1, newest rolled_at first (rides IDX_pull_customer_id_rolled_at)
    // — one query returns both the exact latest pull and the exact total
    // count, no row cap to silently truncate and no stringified-date sort to
    // get chronology wrong. `id` tiebreaks a same-millisecond batch open,
    // same convention as admin/customers/[id]/pulls/route.ts.
    const [[latest], total] = await svc.listAndCountPulls(
      { customer_id: customerId },
      { order: { rolled_at: 'DESC', id: 'DESC' }, skip: 0, take: 1 },
    );
    pullCount = String(total);
    // Numeric compare on the timestamp, not a lexical String() sort — and an
    // invalid/missing rolled_at (NaN) must never be reported as "the latest".
    const t = latest?.rolled_at ? new Date(latest.rolled_at).getTime() : NaN;
    lastPull =
      total === 0
        ? '(never)'
        : Number.isNaN(t)
          ? '(unknown)'
          : String(latest.rolled_at);
  } catch {
    pullCount = 'n/a';
    lastPull = 'n/a';
  }

  let balance = 'n/a';
  try {
    // Same SQL SUM the app itself uses for affordability checks elsewhere
    // (service.ts creditSummary) — exact over the whole ledger, not a
    // Node-side fold over a capped page of transactions.
    const sum = await svc.creditBalance(customerId);
    const [, txnTotal] = await svc.listAndCountCreditTransactions(
      { customer_id: customerId },
      { skip: 0, take: 1 },
    );
    balance = `${sum} (over ${txnTotal} txn)`;
  } catch {
    balance = 'n/a (credit_transaction unreadable)';
  }

  let deposits = 'n/a';
  try {
    const [, total] = await svc.listAndCountGlobePayDeposits(
      { customer_id: customerId },
      { skip: 0, take: 1 },
    );
    const [, settled] = await svc.listAndCountGlobePayDeposits(
      { customer_id: customerId, status: 'settled' },
      { skip: 0, take: 1 },
    );
    deposits = `${total} total / ${settled} settled`;
  } catch {
    deposits = 'n/a';
  }

  return { pullCount, lastPull, balance, deposits };
}

export default async function inspectDuplicatePhonePair({
  container,
}: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const raw = process.env.DUP_IDS?.trim();
  if (!raw) {
    logger.error(
      'DUP_IDS unset — pass the comma-separated customer ids from report-duplicate-phones.ts output.',
    );
    return;
  }
  // De-duplicated, empty entries dropped. Deliberately N >= 2, never pinned
  // to exactly 2 ids: report-duplicate-phones.ts can surface a phone shared
  // by more than two accounts (see docblock), and this inspector must be
  // able to walk the whole cluster. Do not "fix" this to require exactly 2.
  const ids = [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length < 2) {
    logger.error(`DUP_IDS needs at least 2 distinct ids, got ${ids.length}.`);
    return;
  }

  const customerService = container.resolve(Modules.CUSTOMER);
  // Resolved defensively: an unavailable PACKS_MODULE must degrade every
  // activity field to 'n/a' (per the docblock), not throw and blank the
  // customer identity fields too.
  let packs: PacksModuleService | null;
  try {
    packs = container.resolve(PACKS_MODULE) as PacksModuleService;
  } catch {
    packs = null;
  }

  for (const id of ids) {
    const c = await customerService
      .retrieveCustomer(id, {
        select: [
          'id',
          'email',
          'phone',
          'first_name',
          'has_account',
          'created_at',
          'updated_at',
        ],
      })
      .catch(() => null);
    if (!c) {
      logger.info(`[inspect] ${id} — DOES NOT RESOLVE (deleted?)`);
      continue;
    }

    const { pullCount, lastPull, balance, deposits } = packs
      ? await readActivity(packs, id)
      : NO_ACTIVITY;

    logger.info(
      [
        `[inspect] ${c.id}`,
        `  created      ${String(c.created_at)}`,
        `  updated      ${String(c.updated_at)}`,
        `  has_account  ${c.has_account}`,
        `  phone        ${mask(c.phone)}`,
        `  email        ${emailHint(c.email)}`,
        `  first_name   ${c.first_name ? 'set' : '(blank)'}`,
        `  pulls        ${pullCount} (last: ${lastPull})`,
        `  credit       ${balance}`,
        `  deposits     ${deposits}`,
      ].join('\n'),
    );
  }

  logger.info(
    '[inspect] read-only — nothing was modified. Decide which account keeps the phone before any write.',
  );
}
