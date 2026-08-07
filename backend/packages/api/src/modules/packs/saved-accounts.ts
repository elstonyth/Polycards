import { createHash } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import { positiveIntFromEnv } from '../../api/utils/rate-limit';
import type { CustomerMetadataStore } from './service';

// The customer's saved payout destinations — the shape, the deterministic id,
// the defensive parse, and the cooling-off rule that decides whether one may
// receive money yet.
//
// Lives in the module layer (not in the API route that owns the CRUD) because
// three callers need it and they must agree exactly: the saved-accounts route,
// the payout money path (globepay-withdrawal.ts + PacksModuleService
// .withdrawForCashout), and the one-shot backfill script. A module file also
// keeps the money path from importing an API route.

/** Hard cap on saved accounts. A picker, not an address book. */
export const MAX_SAVED_BANK_ACCOUNTS = 5;

export type SavedBankAccount = {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
  /**
   * ISO timestamp of when this destination was FIRST saved — the anchor of the
   * cooling-off window. Optional in the type because the metadata blob predates
   * this field: rows written before it existed have none, and those resolve as
   * NOT usable (see destinationUsableAt). Backfilled for destinations that
   * already received a settled payout — see scripts/backfill-payout-destinations.ts.
   */
  savedAt?: string;
};

/** What the store routes return: the saved account plus the server's verdict on
 *  when it may receive money. The storefront renders `usableFrom` and never
 *  recomputes the window, so retuning the env moves the UI too. */
export type SavedBankAccountView = SavedBankAccount & {
  /** ISO instant this destination becomes usable, or null when it never will
   *  without being re-saved (no `savedAt`). */
  usableFrom: string | null;
};

/**
 * Deterministic id from what the gateway actually pays to. Same bank + same
 * account number = same id, so re-adding an existing account is an idempotent
 * no-op instead of a duplicate picker entry.
 */
export function savedBankAccountId(
  bankCode: string,
  accountNumber: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ bankCode, accountNumber }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Defensive parse of the metadata blob. Metadata is schemaless JSON that other
 * writers merge around; a malformed entry (however it got there) is dropped
 * rather than crashing every reader of the list.
 *
 * `savedAt` is tolerated as absent — that is the pre-cooling-off row shape, and
 * dropping those rows would silently empty a customer's picker. It is carried
 * through only when it is a string; anything else is discarded, which lands the
 * row in the fail-closed "needs re-saving" state rather than a parse crash.
 */
export function parseSavedBankAccounts(value: unknown): SavedBankAccount[] {
  if (!Array.isArray(value)) return [];
  const accounts: SavedBankAccount[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.id === 'string' &&
      typeof e.bankCode === 'string' &&
      typeof e.bankName === 'string' &&
      typeof e.accountNumber === 'string' &&
      typeof e.accountHolderName === 'string'
    ) {
      accounts.push({
        id: e.id,
        bankCode: e.bankCode,
        bankName: e.bankName,
        accountNumber: e.accountNumber,
        accountHolderName: e.accountHolderName,
        ...(typeof e.savedAt === 'string' ? { savedAt: e.savedAt } : {}),
      });
    }
  }
  return accounts;
}

/**
 * Hours a newly saved destination must wait before it can receive a payout.
 *
 * Read PER CALL (the plan-066 convention, same as GLOBEPAY_WD_DAILY_MAX_RM) so
 * support can retune it without a redeploy. positiveIntFromEnv only accepts a
 * positive safe integer: `0`, a fraction and any garbage fall back to 24 and
 * warn, so the smallest window an operator can actually set is 1 hour and the
 * cooling-off can never be switched off by an env typo.
 */
export function payoutDestinationCooldownHours(): number {
  return positiveIntFromEnv('PAYOUT_DESTINATION_COOLDOWN_HOURS', 24);
}

/**
 * When this destination becomes usable, or null when it cannot without being
 * re-saved.
 *
 * A missing (or unparseable) `savedAt` resolves to null — NOT to "usable". This
 * is a money path: `undefined` must never read as permission, so the absent case
 * is the refused case and the customer re-saves the account to start a fresh
 * window. The backfill exists so nobody who already withdrew has to.
 */
export function destinationUsableAt(
  account: SavedBankAccount,
  cooldownHours: number = payoutDestinationCooldownHours(),
): Date | null {
  if (typeof account.savedAt !== 'string') return null;
  const savedAt = new Date(account.savedAt);
  if (Number.isNaN(savedAt.getTime())) return null;
  return new Date(savedAt.getTime() + cooldownHours * 60 * 60 * 1000);
}

/** Project a stored list for a store response. */
export function savedBankAccountViews(
  accounts: SavedBankAccount[],
  cooldownHours: number = payoutDestinationCooldownHours(),
): SavedBankAccountView[] {
  return accounts.map((account) => {
    const usableAt = destinationUsableAt(account, cooldownHours);
    return { ...account, usableFrom: usableAt ? usableAt.toISOString() : null };
  });
}

/** "about 3 hours" / "about 20 minutes" — a wait, not a wall-clock time, so the
 *  message carries no timezone claim to get wrong. Rounds UP so it never
 *  promises a moment that is still refused. */
function waitLabel(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 90) {
    return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.ceil(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Resolve the destination a payout may pay to, or throw the customer-facing
 * refusal. The ONLY way the money path learns a bank code and account number:
 * they are never read from a request body.
 *
 * Three distinct refusals, because they need three different customer actions:
 *   - unknown id      -> pick one from the list (or the id is not theirs; the
 *                        caller only ever passes the token owner's list, so a
 *                        cross-customer id lands here)
 *   - no `savedAt`    -> re-save the account, then wait
 *   - still cooling   -> wait, and how long
 */
export function resolveWithdrawalDestination(args: {
  accounts: SavedBankAccount[];
  accountId: unknown;
  now?: Date;
  cooldownHours?: number;
}): SavedBankAccount {
  const { accountId } = args;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Select a saved bank account.',
    );
  }
  const account = args.accounts.find((a) => a.id === accountId);
  if (!account) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Select a saved bank account.',
    );
  }

  const usableAt = destinationUsableAt(account, args.cooldownHours);
  if (!usableAt) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This bank account was saved before withdrawal checks were added. Remove it and save it again to use it.',
    );
  }
  const now = args.now ?? new Date();
  if (now.getTime() < usableAt.getTime()) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `This bank account is not available for withdrawals yet — try again in ${waitLabel(
        usableAt.getTime() - now.getTime(),
      )}.`,
    );
  }
  return account;
}

/**
 * Read one customer's saved accounts. Read-only, takes no lock: callers that
 * WRITE the list go through PacksModuleService.mutateCustomerMetadata, which
 * does its own locked read.
 */
export async function loadSavedBankAccounts(
  customers: Pick<CustomerMetadataStore, 'retrieveCustomer'>,
  customerId: string,
): Promise<SavedBankAccount[]> {
  const customer = await customers.retrieveCustomer(customerId);
  const metadata = (customer.metadata ?? {}) as Record<string, unknown>;
  return parseSavedBankAccounts(metadata.bank_accounts);
}
