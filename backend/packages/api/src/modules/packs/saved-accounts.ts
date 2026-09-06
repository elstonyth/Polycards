import { createHash } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import { findBank, gatewayBankCode, sandboxOnlyBank } from './banks';
// Type-only: a value import of gateway.ts from here would cycle through the
// module index into the service, which imports this file.
import type { PaymentGateway } from './gateway';

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
  /** Can the ACTIVE payment gateway pay to this bank? Saved accounts survive
   *  a gateway switch; one the new gateway cannot reach is kept, shown, and
   *  refused until a gateway that serves the bank is active again. */
  supported: boolean;
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
      // Entries written before the bank registry carry a gateway's own code
      // (GlobePay's, historically). Read them as the canonical bank, with the
      // id recomputed to match — the id is derived from (bankCode, account),
      // and resolveWithdrawalDestination enforces that derivation. The next
      // write persists the canonical form; until then every read converts.
      const bank = findBank(e.bankCode);
      const bankCode = bank?.id ?? e.bankCode;
      accounts.push({
        id:
          bankCode === e.bankCode
            ? e.id
            : savedBankAccountId(bankCode, e.accountNumber),
        bankCode,
        bankName: bank?.name ?? e.bankName,
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
 * `0` switches the wait OFF — a saved account can be paid immediately.
 *
 * Read PER CALL (the plan-066 convention, same as GLOBEPAY_WD_DAILY_MAX_RM) so
 * support can retune it without a redeploy.
 *
 * Parsed here rather than through positiveIntFromEnv, which refuses `0` on
 * purpose: that helper is shared with the rate limiter, where windowMs=0 would
 * disable a rule and limit=0 would hard-block an endpoint. This setting is the
 * one place `0` is a meaningful value, so it gets its own parse instead of
 * loosening a helper the rate limiter depends on.
 *
 * OFF IS A DELIBERATE OPERATOR CHOICE, NOT A DEFAULT. Unset still means 24: the
 * window is what stops a stolen customer token from adding a bank account and
 * cashing out in one sitting, so only an explicit `0` may disarm it. A fraction,
 * a negative and any garbage all fall back to 24 and warn — `"0.5"` in
 * particular must not floor its way to "off".
 */
export function payoutDestinationCooldownHours(): number {
  const raw = process.env.PAYOUT_DESTINATION_COOLDOWN_HOURS;
  if (raw === undefined || raw === '') return 24;
  const hours = Number(raw);
  if (!Number.isSafeInteger(hours) || hours < 0) {
    console.warn(
      `[saved-accounts] ignoring invalid PAYOUT_DESTINATION_COOLDOWN_HOURS=${JSON.stringify(
        raw,
      )}; using 24`,
    );
    return 24;
  }
  return hours;
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
  gateway: PaymentGateway,
  cooldownHours: number = payoutDestinationCooldownHours(),
): SavedBankAccountView[] {
  return accounts.map((account) => {
    const usableAt = destinationUsableAt(account, cooldownHours);
    return {
      ...account,
      usableFrom: usableAt ? usableAt.toISOString() : null,
      supported: bankSupportedBy(account.bankCode, gateway),
    };
  });
}

/**
 * Can `gateway` pay to this bank? A code the registry does not know is
 * unsupported everywhere (nothing could pay to it). The sandbox dummy bank
 * is supported only while the sandbox is configured.
 */
export function bankSupportedBy(
  bankCode: string,
  gateway: PaymentGateway,
  env: { TGPAY_API_BASE?: string } = process.env,
): boolean {
  if (sandboxOnlyBank(bankCode, env)) return false;
  return Boolean(gatewayBankCode(bankCode, gateway));
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

  // The id is not a label, it is sha256(bankCode, accountNumber). That
  // derivation is the ONLY reason an id cannot be repointed at a different bank
  // account — it is what lets the withdraw route accept an `account_id` and no
  // bank fields at all. Today it holds because every writer computes it (the
  // save route, the backfill script); recomputing it HERE makes it hold by
  // enforcement instead of by convention, at the single read the money path
  // depends on. Any future writer that forgets savedBankAccountId, or anything
  // that reaches customer metadata directly, is refused rather than paid.
  //
  // Same message as the unknown-id branch on purpose: a caller learns "not a
  // valid destination", never "tampering detected".
  if (
    savedBankAccountId(account.bankCode, account.accountNumber) !== account.id
  ) {
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

/** The MikroORM manager surface this file needs — declared structurally rather
 *  than imported from service.ts, which imports this module. */
type SqlManager = {
  execute<T = unknown>(query: string, params?: unknown[]): Promise<T>;
};

/**
 * Read one customer's saved accounts, on whatever manager the caller hands in.
 *
 * Raw SQL rather than the customer module's `retrieveCustomer`, and the SELECT
 * is byte-identical to the one mutateCustomerMetadata uses, so the read and the
 * write of this blob agree on what "the current metadata" is. The payoff is at
 * the call site in withdrawForCashout: passing that method's own transaction
 * manager puts this read on the SAME connection and transaction as the advisory
 * lock and the debit, instead of on a second connection the lock has no
 * relationship with.
 *
 * Takes no lock ITSELF — the caller decides. Writers go through
 * PacksModuleService.mutateCustomerMetadata, which locks `metadata:<customer>`.
 *
 * A customer id that matches no row yields an empty list, so the destination
 * lookup refuses with "Select a saved bank account." That is the fail-closed
 * direction: a deleted or unknown customer has no saved destination.
 */
export async function loadSavedBankAccounts(
  em: SqlManager,
  customerId: string,
): Promise<SavedBankAccount[]> {
  const rows = await em.execute<{ metadata: Record<string, unknown> | null }[]>(
    'SELECT metadata FROM customer WHERE id = ? AND deleted_at IS NULL',
    [customerId],
  );
  return parseSavedBankAccounts((rows[0]?.metadata ?? {}).bank_accounts);
}
