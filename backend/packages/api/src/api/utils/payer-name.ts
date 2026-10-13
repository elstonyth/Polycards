import type { AuthenticatedMedusaRequest } from '@medusajs/framework/http';
import { resolvePacks } from '../../modules/packs/facets';
import type { PaymentGateway } from '../../modules/packs/gateway';
import type PacksModuleService from '../../modules/packs/service';
import { bankSupportedBy } from '../../modules/packs/saved-accounts';

/** A name compared the way a person reads it: case and spacing ignored. */
export const nameKey = (name: string) =>
  name.replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * The paying account's holder name for a gateway that matches transfers
 * against it (A3Pay, SGD), from the customer's SAVED bank accounts at a bank
 * this gateway pays, in the exact spelling their bank uses:
 *   1. the saved holder that IS the customer (matches the real name);
 *   2. the only holder, when there is just one.
 * `onFile` is undefined otherwise (none saved, or several people's
 * accounts): the top-up sheet then asks for the name, pre-filled with
 * `realName`. The real name alone is never sent: it is free text, and a
 * nickname failed A3Pay's name check (Verify Fail, 2026-10-13). Only the
 * customer knows the paying account's exact name.
 */
export async function payerNameOnFile(
  scope: AuthenticatedMedusaRequest['scope'],
  customerId: string,
  gateway: PaymentGateway,
): Promise<{ onFile: string | undefined; realName: string | null }> {
  const packs =
    resolvePacks<
      Pick<PacksModuleService, 'savedBankAccountsFor' | 'getVerificationState'>
    >(scope);
  const [saved, { realName }] = await Promise.all([
    packs.savedBankAccountsFor(customerId),
    packs.getVerificationState(customerId),
  ]);
  const holders = saved
    .filter((a) => bankSupportedBy(a.bankCode, gateway))
    .map((a) => a.accountHolderName.trim())
    .filter(Boolean);
  const own = realName
    ? holders.find((holder) => nameKey(holder) === nameKey(realName))
    : undefined;
  const distinct = new Set(holders.map(nameKey));
  return {
    onFile: own ?? (distinct.size === 1 ? holders[0] : undefined),
    realName: realName ?? null,
  };
}
