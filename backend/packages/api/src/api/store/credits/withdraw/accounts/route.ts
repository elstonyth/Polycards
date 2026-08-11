import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { withdrawalDetailsError } from '../../../../../modules/packs/globepay-withdrawal';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import {
  MAX_SAVED_BANK_ACCOUNTS,
  parseSavedBankAccounts,
  savedBankAccountId,
  savedBankAccountViews,
  type SavedBankAccount,
} from '../../../../../modules/packs/saved-accounts';
import { sendSavedAccountAddedNotice } from '../../../../../modules/packs/saved-account-notice';

// Saved payout bank accounts — GET (list) / POST (add) / DELETE (remove) on
// /store/credits/withdraw/accounts. Storage is customer.metadata.bank_accounts,
// merged read-modify-write like the avatar/frame routes.
//
// WHAT KEEPS THIS ROUTE THE ONLY WRITER is our own middleware, NOT the
// framework. Medusa's stock POST /store/customers/me *accepts* client metadata:
// node_modules/@medusajs/medusa/dist/api/store/customers/validators.js declares
// StoreUpdateCustomer with `metadata: z.record(z.unknown()).nullish()`, and
// .../customers/me/route.js passes req.validatedBody straight into
// updateCustomersWorkflow. The only thing that refuses it is
// rejectCustomerMetadata (utils/customer-metadata-guard.ts), wired at
// middlewares.ts:405 (/store/customers) and :419 (/store/customers/me).
//
// Since plan 088 that guard is a MONEY CONTROL, not the cosmetic one it was
// written as. It no longer merely protects an avatar URL or an equipped frame:
// it is the only thing between a stolen customer bearer token and an arbitrary
// payout destination. Unwire it and a token holder can POST a whole
// bank_accounts array — including a backdated `savedAt` that clears the
// cooling-off window below — then withdraw to it. Do not "simplify" it away on
// the belief that the framework already rejects metadata.
//
// Both writes go through
// PacksModuleService.mutateCustomerMetadata, which holds a `metadata:<customer>`
// advisory lock across the read and the write — the blob is shared with the
// avatar and frame routes, and an unlocked merge drops whichever key the loser
// had just written.
//
// THIS LIST IS THE ENFORCEMENT POINT for where a payout may go (plan 088; it
// used to be a convenience store, and that comment is gone because it stopped
// being true). POST /store/credits/withdraw carries an `account_id` and no bank
// fields at all: the bank code, account number and holder name it submits to the
// gateway are resolved from this list, inside the debiting transaction, by
// modules/packs/saved-accounts.ts. Two consequences to keep in mind here:
//
//   - Every account is stamped with `savedAt` on creation and cannot receive
//     money until PAYOUT_DESTINATION_COOLDOWN_HOURS have passed — 24 unless an
//     operator sets it, and `0` switches the wait off entirely. Adding a
//     destination is a security event either way, not a preference — hence the
//     email + feed notice below, which is the ONLY control left when the wait is
//     zero.
//   - The same withdrawalDetailsError the payout path uses still gates a save,
//     so the picker can never offer an account the submit would reject.
//
// AUTH + RATE LIMIT: registered in src/api/middlewares.ts. The customer id
// comes ONLY from the verified token — an account list is per-customer and
// never keyed by anything in the body.

// Re-exported for the module's own tests and any older importer: the
// definitions moved to modules/packs/saved-accounts.ts so the money path and
// the backfill script can share them without importing an API route.
export {
  MAX_SAVED_BANK_ACCOUNTS,
  parseSavedBankAccounts,
  savedBankAccountId,
  type SavedBankAccount,
};

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
  noStore(res).json({ accounts: savedBankAccountViews(accounts) });
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
    savedAt: new Date().toISOString(),
  };

  // The cap is checked against the list read INSIDE the lock, not against one
  // this handler read earlier — otherwise two concurrent saves could both see
  // MAX-1 accounts and both be allowed through.
  let added = false;
  const saved = await mutateAccounts(req, customerId, (accounts) => {
    const existing = accounts.findIndex((a) => a.id === account.id);
    if (existing >= 0) {
      // Idempotent re-add: refresh the label/holder in place (a customer fixing
      // a typo'd holder name must not need a delete + re-add dance), but KEEP
      // the original savedAt so the cooling-off window is not restarted. Safe
      // because savedBankAccountId is derived from (bankCode, accountNumber):
      // a re-add cannot repoint an id at a different bank account, only relabel
      // the one it already names. A row that predates savedAt keeps having
      // none — re-saving a stale account must not silently arm it, only a
      // delete-then-add (a new entry, stamped now) does.
      const prior = accounts[existing] as SavedBankAccount;
      return accounts.map((a, i) =>
        i === existing ? { ...account, savedAt: prior.savedAt } : a,
      );
    }
    if (accounts.length >= MAX_SAVED_BANK_ACCOUNTS) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `You can save up to ${MAX_SAVED_BANK_ACCOUNTS} bank accounts — remove one first.`,
      );
    }
    added = true;
    return [...accounts, account];
  });

  // A NEW payout destination is the event worth telling the account owner
  // about: it is the first half of "steal a token, wait out the cooling-off,
  // cash out". Fired after the write has committed and never allowed to fail
  // the save (the helper swallows its own errors) — a dropped notice must not
  // cost the customer their saved account. Re-saving an account they already
  // had is not news, so it stays silent.
  if (added) {
    await sendSavedAccountAddedNotice(req.scope, {
      customerId,
      accountId: account.id,
      bankName: account.bankName,
      accountNumber: account.accountNumber,
      savedAt: account.savedAt as string,
    });
  }
  noStore(res).json({ accounts: savedBankAccountViews(saved) });
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
  noStore(res).json({ accounts: savedBankAccountViews(saved) });
}
