import type { AuthenticatedMedusaRequest } from '@medusajs/framework/http';
import { resolvePacks } from '../../modules/packs/facets';
import type { PaymentGateway } from '../../modules/packs/gateway';
import type PacksModuleService from '../../modules/packs/service';
import {
  bankSupportedBy,
  type SavedBankAccount,
} from '../../modules/packs/saved-accounts';

/** A name compared the way a person reads it: case and spacing ignored. */
export const nameKey = (name: string) =>
  name.replace(/\s+/g, ' ').trim().toUpperCase();

type Scope = AuthenticatedMedusaRequest['scope'];

/** The customer's saved accounts and real name, in one round of reads. */
async function savedAndRealName(
  scope: Scope,
  customerId: string,
): Promise<{ saved: SavedBankAccount[]; realName: string | null }> {
  const packs =
    resolvePacks<
      Pick<PacksModuleService, 'savedBankAccountsFor' | 'getVerificationState'>
    >(scope);
  const [saved, { realName }] = await Promise.all([
    packs.savedBankAccountsFor(customerId),
    packs.getVerificationState(customerId),
  ]);
  return { saved, realName: realName ?? null };
}

/** The holder rule of payerNameOnFile, over already-loaded accounts. */
function holderOnFile(
  saved: SavedBankAccount[],
  realName: string | null,
  gateway: PaymentGateway,
): string | undefined {
  const holders = saved
    .filter((a) => bankSupportedBy(a.bankCode, gateway))
    .map((a) => a.accountHolderName.trim())
    .filter(Boolean);
  const own = realName
    ? holders.find((holder) => nameKey(holder) === nameKey(realName))
    : undefined;
  const distinct = new Set(holders.map(nameKey));
  return own ?? (distinct.size === 1 ? holders[0] : undefined);
}

/**
 * The paying account's holder name for a gateway that matches transfers
 * against it (A3Pay, GMpay: SGD), from the customer's SAVED bank accounts at
 * a bank this gateway pays, in the exact spelling their bank uses:
 *   1. the saved holder that IS the customer (matches the real name);
 *   2. the only holder, when there is just one.
 * `onFile` is undefined otherwise (none saved, or several people's
 * accounts): the top-up sheet then asks for the name, pre-filled with
 * `realName`. The real name alone is never sent: it is free text, and a
 * nickname failed A3Pay's name check (Verify Fail, 2026-10-13). Only the
 * customer knows the paying account's exact name.
 */
export async function payerNameOnFile(
  scope: Scope,
  customerId: string,
  gateway: PaymentGateway,
): Promise<{ onFile: string | undefined; realName: string | null }> {
  const { saved, realName } = await savedAndRealName(scope, customerId);
  return { onFile: holderOnFile(saved, realName, gateway), realName };
}

/**
 * The saved account a pay-in declares as the paying one (GMpay): the most
 * recently saved account, at a bank this gateway serves, HELD BY the name
 * the payment carries. Never another person's account beside that name: a
 * name with no saved account of its own declares nothing, and the deposit is
 * refused before any row (gateway-deposit.ts PAYER_BANK_REQUIRED_MESSAGE).
 */
export function payerAccountFor(
  saved: SavedBankAccount[],
  gateway: PaymentGateway,
  payerName: string | undefined,
): { bankCode: string; accountNumber: string } | undefined {
  if (!payerName?.trim()) return undefined;
  const newest = saved
    .filter(
      (a) =>
        bankSupportedBy(a.bankCode, gateway) &&
        a.accountNumber.trim() &&
        nameKey(a.accountHolderName) === nameKey(payerName),
    )
    .sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''))[0];
  return newest
    ? { bankCode: newest.bankCode, accountNumber: newest.accountNumber }
    : undefined;
}

/**
 * Both halves of the payer for a gateway that declares the paying account
 * (GMpay), from one round of reads: the name (the one the sheet sent, else
 * the holder on file) and the saved account held in that name.
 */
export async function payerOnFile(
  scope: Scope,
  customerId: string,
  gateway: PaymentGateway,
  typedName: string | undefined,
): Promise<{
  name: string | undefined;
  account: { bankCode: string; accountNumber: string } | undefined;
}> {
  const { saved, realName } = await savedAndRealName(scope, customerId);
  const name = typedName?.trim()
    ? typedName
    : holderOnFile(saved, realName, gateway);
  return { name, account: payerAccountFor(saved, gateway, name) };
}
