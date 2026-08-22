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
 * `retrieveCustomer` and `list*` reads.
 *
 * Ids come from the report's own output and are passed in, never discovered
 * here, so this can only ever look at a pair an operator already chose:
 *
 *   DUP_IDS=cus_a,cus_b medusa exec ./src/scripts/inspect-duplicate-phone-pair.ts
 *
 * PII: the phone is masked to its last 4 (same rule as the report) and the
 * email is reduced to a shape hint (first char + domain), never printed whole.
 * That is enough to tell "same human, two signups" from "two different
 * humans", which is the decision this exists to support.
 */
const mask = (phone?: string | null): string =>
  phone ? `••••${phone.slice(-4)}` : '(none)';

const emailHint = (email?: string | null): string => {
  if (!email) return '(none)';
  const [local, domain] = email.split('@');
  if (!domain) return '(malformed)';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
};

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
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length < 2) {
    logger.error(`DUP_IDS needs at least 2 ids, got ${ids.length}.`);
    return;
  }

  const customerService = container.resolve(Modules.CUSTOMER);
  const packs = container.resolve(PACKS_MODULE) as PacksModuleService;

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

    // Activity signals. Each is an independent read; a module that is
    // unavailable degrades to 'n/a' rather than aborting the whole report.
    const pulls = await packs
      .listPulls({ customer_id: id }, { take: 1000 })
      .catch(() => null);

    let balance: string = 'n/a';
    try {
      const txns = await packs.listCreditTransactions(
        { customer_id: id },
        { take: 5000 },
      );
      const sum = txns.reduce(
        (s: number, t: { amount?: unknown }) => s + Number(t.amount ?? 0),
        0,
      );
      balance = `${sum} (over ${txns.length} txn)`;
    } catch {
      balance = 'n/a (credit_transaction unreadable)';
    }

    let deposits = 'n/a';
    try {
      const d = await packs.listGlobePayDeposits(
        { customer_id: id },
        { take: 500 },
      );
      const settled = d.filter(
        (r: { status?: string }) => r.status === 'settled',
      ).length;
      deposits = `${d.length} total / ${settled} settled`;
    } catch {
      deposits = 'n/a';
    }

    const lastPull = pulls?.length
      ? pulls
          .map((p: { rolled_at?: Date | string }) => String(p.rolled_at ?? ''))
          .sort()
          .at(-1)
      : '(never)';

    logger.info(
      [
        `[inspect] ${c.id}`,
        `  created      ${String(c.created_at)}`,
        `  updated      ${String(c.updated_at)}`,
        `  has_account  ${c.has_account}`,
        `  phone        ${mask(c.phone)}`,
        `  email        ${emailHint(c.email)}`,
        `  first_name   ${c.first_name ? 'set' : '(blank)'}`,
        `  pulls        ${pulls ? pulls.length : 'n/a'} (last: ${lastPull})`,
        `  credit       ${balance}`,
        `  deposits     ${deposits}`,
      ].join('\n'),
    );
  }

  logger.info(
    '[inspect] read-only — nothing was modified. Decide which account keeps the phone before any write.',
  );
}
