import type { Context } from '@medusajs/framework/types';
import type { LedgerSqlManager } from './claim';

// Credit posting: the one home of the per-customer credit lock (design
// plans/architecture-deepening/03-credit-posting-design.md). No service
// import, so the service and its helper files can all use it.

/** The per-customer credit lock key. Keep it byte-identical across releases:
 *  during a rolling deploy old and new pods must still exclude each other. */
export const creditLockKey = (customerId: string): string => `credit:${customerId}`;

/**
 * Takes the per-customer credit advisory lock for each id, on the caller's
 * transaction, in sorted order (deadlock-safe; the same default sort
 * reverseOpen always used). Re-entrant per session, so a posting composed
 * onto a transaction that already holds the key does not wait on itself.
 * Lock order contract: `adjust-idem:` → mint window → `credit:` →
 * `tickets:` / `delivery:` / pull FOR UPDATE, and `open:` → `credit:`; at
 * most one distinct `credit:` key per transaction except reverseOpen.
 * Errors pass through untouched (callers translate 55P03 themselves).
 */
export async function lockCredit(context: Context, ...customerIds: string[]): Promise<void> {
  const em = context.transactionManager as unknown as LedgerSqlManager | undefined;
  // An xact lock outside a transaction is released at once: never a lock.
  if (!em) throw new Error('lockCredit needs the caller\'s transaction.');
  for (const id of [...new Set(customerIds)].sort()) {
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [creditLockKey(id)]);
  }
}
