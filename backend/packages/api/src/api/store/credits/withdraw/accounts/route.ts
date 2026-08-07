import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { createHash } from 'node:crypto';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { withdrawalDetailsError } from '../../../../../modules/packs/globepay-withdrawal';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// Saved payout bank accounts — GET (list) / POST (add) / DELETE (remove) on
// /store/credits/withdraw/accounts. Storage is customer.metadata.bank_accounts,
// merged read-modify-write like the avatar/frame routes (the stock
// POST /store/customers/me rejects client metadata, so a validated custom
// route is the only way a customer can write these). Both writes go through
// PacksModuleService.mutateCustomerMetadata, which holds a `metadata:<customer>`
// advisory lock across the read and the write — the blob is shared with the
// avatar and frame routes, and an unlocked merge drops whichever key the loser
// had just written.
//
// This is a CONVENIENCE store, not the enforcement point: the actual payout
// (POST /store/credits/withdraw) re-validates every field on submit, and the
// gateway pays only to what that request carries. Saving a malformed account
// here is therefore refused with the same withdrawalDetailsError the payout
// path uses, so the picker can never offer an account the submit would reject.
//
// AUTH + RATE LIMIT: registered in src/api/middlewares.ts. The customer id
// comes ONLY from the verified token — an account list is per-customer and
// never keyed by anything in the body.

/** Hard cap on saved accounts. A picker, not an address book. */
export const MAX_SAVED_BANK_ACCOUNTS = 5;

export type SavedBankAccount = {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
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
      });
    }
  }
  return accounts;
}

/**
 * Register-phase JWTs pass authenticate('customer') with actor_id '' (the
 * documented repo trap — see profile/frame/route.ts). Without this guard,
 * retrieveCustomer('') surfaces as a confusing NOT_FOUND instead of a 401, and
 * the client's isAuthError never offers the login prompt. Single choke point:
 * every handler runs this before touching anything.
 */
function requireCustomerId(customerId: string): string {
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  return customerId;
}

/** Read-only list for GET. The write paths do their own read INSIDE the lock. */
async function loadAccounts(
  req: AuthenticatedMedusaRequest,
  customerId: string,
): Promise<SavedBankAccount[]> {
  const customers = req.scope.resolve(Modules.CUSTOMER);
  const customer = await customers.retrieveCustomer(
    requireCustomerId(customerId),
  );
  const metadata = (customer.metadata ?? {}) as Record<string, unknown>;
  return parseSavedBankAccounts(metadata.bank_accounts);
}

/**
 * Run `mutate` against this customer's metadata under the
 * `metadata:<customer>` advisory lock and return the saved list as it was
 * actually written — never as the caller hoped to write it.
 */
async function mutateAccounts(
  req: AuthenticatedMedusaRequest,
  customerId: string,
  mutate: (accounts: SavedBankAccount[]) => SavedBankAccount[] | null,
): Promise<SavedBankAccount[]> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const metadata = await packs.mutateCustomerMetadata({
    customerId: requireCustomerId(customerId),
    mutate: (current) => {
      const next = mutate(parseSavedBankAccounts(current.bank_accounts));
      return next === null ? null : { ...current, bank_accounts: next };
    },
  });
  return parseSavedBankAccounts(metadata.bank_accounts);
}

/**
 * Every response here carries full account numbers, so none of them may land
 * in a shared/browser cache (CWE-525). Applied to all three handlers — POST
 * and DELETE echo the same list GET serves.
 */
function noStore(res: MedusaResponse): MedusaResponse {
  res.setHeader('Cache-Control', 'no-store');
  return res;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const accounts = await loadAccounts(req, req.auth_context.actor_id);
  noStore(res).json({ accounts });
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = requireCustomerId(req.auth_context.actor_id);
  const body = (req.body ?? {}) as {
    bank_code?: unknown;
    bank_name?: unknown;
    account_number?: unknown;
    account_holder_name?: unknown;
  };

  // Same gate as the payout submit, so the saved list can never hold an
  // account the withdraw path would refuse.
  const invalid = withdrawalDetailsError({
    bankCode: body.bank_code,
    accountNumber: body.account_number,
    accountHolderName: body.account_holder_name,
  });
  if (invalid) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, invalid);
  }
  // bankName is display-only (the picker label); the code is what pays. Still
  // bounded so metadata can't be stuffed through the free-text field.
  const bankName = body.bank_name;
  if (
    typeof bankName !== 'string' ||
    bankName.trim().length < 2 ||
    bankName.trim().length > 120
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Choose a bank from the list.',
    );
  }

  const bankCode = body.bank_code as string;
  const accountNumber = body.account_number as string;
  const account: SavedBankAccount = {
    id: savedBankAccountId(bankCode, accountNumber),
    bankCode,
    bankName: bankName.trim(),
    accountNumber,
    accountHolderName: (body.account_holder_name as string).trim(),
  };

  // The cap is checked against the list read INSIDE the lock, not against one
  // this handler read earlier — otherwise two concurrent saves could both see
  // MAX-1 accounts and both be allowed through.
  const saved = await mutateAccounts(req, customerId, (accounts) => {
    const existing = accounts.findIndex((a) => a.id === account.id);
    if (existing >= 0) {
      // Idempotent re-add: refresh the label/holder in place (a customer fixing
      // a typo'd holder name must not need a delete + re-add dance).
      return accounts.map((a, i) => (i === existing ? account : a));
    }
    if (accounts.length >= MAX_SAVED_BANK_ACCOUNTS) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `You can save up to ${MAX_SAVED_BANK_ACCOUNTS} bank accounts — remove one first.`,
      );
    }
    return [...accounts, account];
  });
  noStore(res).json({ accounts: saved });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = requireCustomerId(req.auth_context.actor_id);
  const id = (req.body as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Say which saved account to remove.',
    );
  }

  const saved = await mutateAccounts(req, customerId, (accounts) => {
    const next = accounts.filter((a) => a.id !== id);
    // Removing an already-gone account succeeds: the customer's goal (that
    // account no longer listed) is met, and a refresh-then-retry must not
    // error. `null` = nothing changed, so no write is issued at all.
    return next.length === accounts.length ? null : next;
  });
  noStore(res).json({ accounts: saved });
}
