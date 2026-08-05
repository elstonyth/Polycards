import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { createHash } from 'node:crypto';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { withdrawalDetailsError } from '../../../../../modules/packs/globepay-withdrawal';

// Saved payout bank accounts — GET (list) / POST (add) / DELETE (remove) on
// /store/credits/withdraw/accounts. Storage is customer.metadata.bank_accounts,
// merged read-modify-write like the avatar/frame routes (the stock
// POST /store/customers/me rejects client metadata, so a validated custom
// route is the only way a customer can write these).
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

async function loadAccounts(
  req: AuthenticatedMedusaRequest,
  customerId: string,
): Promise<{ accounts: SavedBankAccount[]; metadata: Record<string, unknown> }> {
  const customers = req.scope.resolve(Modules.CUSTOMER);
  const customer = await customers.retrieveCustomer(customerId);
  const metadata = (customer.metadata ?? {}) as Record<string, unknown>;
  return { accounts: parseSavedBankAccounts(metadata.bank_accounts), metadata };
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { accounts } = await loadAccounts(req, req.auth_context.actor_id);
  res.json({ accounts });
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
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

  const { accounts, metadata } = await loadAccounts(req, customerId);
  const existing = accounts.findIndex((a) => a.id === account.id);
  let next: SavedBankAccount[];
  if (existing >= 0) {
    // Idempotent re-add: refresh the label/holder in place (a customer fixing
    // a typo'd holder name must not need a delete + re-add dance).
    next = accounts.map((a, i) => (i === existing ? account : a));
  } else {
    if (accounts.length >= MAX_SAVED_BANK_ACCOUNTS) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `You can save up to ${MAX_SAVED_BANK_ACCOUNTS} bank accounts — remove one first.`,
      );
    }
    next = [...accounts, account];
  }

  const customers = req.scope.resolve(Modules.CUSTOMER);
  await customers.updateCustomers(customerId, {
    metadata: { ...metadata, bank_accounts: next },
  });
  res.json({ accounts: next });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const id = (req.body as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Say which saved account to remove.',
    );
  }

  const { accounts, metadata } = await loadAccounts(req, customerId);
  const next = accounts.filter((a) => a.id !== id);
  // Removing an already-gone account succeeds: the customer's goal (that
  // account no longer listed) is met, and a refresh-then-retry must not error.
  if (next.length !== accounts.length) {
    const customers = req.scope.resolve(Modules.CUSTOMER);
    await customers.updateCustomers(customerId, {
      metadata: { ...metadata, bank_accounts: next },
    });
  }
  res.json({ accounts: next });
}
