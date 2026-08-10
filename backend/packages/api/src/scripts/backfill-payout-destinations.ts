/**
 * backfill-payout-destinations.ts
 *
 * Grandfathering for plan 088 (payouts now pay only to a SAVED destination that
 * has cooled off). Without this, every existing customer's next withdrawal is
 * delayed by PAYOUT_DESTINATION_COOLDOWN_HOURS even though they have already
 * been paid to that exact bank account before.
 *
 * What it does, per customer: every destination that has received a SETTLED
 * payout is written into `customer.metadata.bank_accounts` with `savedAt` set to
 * that payout's timestamp — a past instant, so the destination is already out of
 * its cooling-off window and usable immediately. Nothing else is touched.
 *
 * Only `settled` counts. A `pending` row is money we are not sure landed, and a
 * `failed` one is money that came back — neither is evidence the customer
 * controls that account, which is the entire premise of grandfathering it.
 *
 * RUN (backend must be up), after the code that reads `savedAt` has deployed:
 *   corepack yarn medusa exec ./src/scripts/backfill-payout-destinations.ts
 *
 * IDEMPOTENT, in both directions:
 *   - the saved-account id is the SAME deterministic sha256 of
 *     (bankCode, accountNumber) the live route uses, so a destination already in
 *     the list is found rather than duplicated;
 *   - an existing `savedAt` is NEVER overwritten — a re-run must not move a
 *     customer's window in either direction, and must not re-arm an account the
 *     customer deliberately re-saved later;
 *   - when a customer needs no change the mutate callback returns null, so no
 *     write is issued at all. A second run therefore reports 0 stamped, 0 added.
 *
 * The cap is respected: a customer already holding MAX_SAVED_BANK_ACCOUNTS gets
 * nothing added (their oldest historical destinations are skipped and counted in
 * the summary) — the picker's bound is not something a backfill may quietly
 * raise.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import PacksModuleService from '../modules/packs/service';
import { PACKS_MODULE } from '../modules/packs';
import {
  MAX_SAVED_BANK_ACCOUNTS,
  savedBankAccountId,
  parseSavedBankAccounts,
  type SavedBankAccount,
} from '../modules/packs/saved-accounts';
import {
  getSupportedBanks,
  globepayConfigFromEnv,
} from '../modules/packs/globepay-client';

type SettledDestination = {
  customer_id: string;
  bank_code: string;
  account_number: string;
  account_holder_name: string;
  /** When this destination was FIRST settled — the savedAt we stamp. Held as a
   *  Date only after an explicit `new Date(...)`: the SQL read hands back a raw
   *  driver value, and this script's only real run is against production, where
   *  a `.getTime()` on a string would abort the whole backfill on customer one.
   *  Same discipline as every other raw-SQL read in service.ts. */
  first_settled_at: Date;
};

export default async function backfillPayoutDestinations({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  // The picker's label. It lives only in the gateway's bank list, never on the
  // withdrawal row, so ask them once. If that call is unavailable (payouts
  // switched off, credentials absent in the run environment) the bank CODE is
  // used as the label — recognisable enough to pick from, and the code is what
  // actually pays either way.
  let bankNames = new Map<string, string>();
  try {
    const banks = await getSupportedBanks(globepayConfigFromEnv());
    bankNames = new Map(banks.map((b) => [b.bankCode, b.bankName]));
  } catch (error) {
    logger.warn(
      `[backfill-payout-destinations] bank list unavailable (${
        error instanceof Error ? error.message : String(error)
      }); falling back to bank codes as labels.`,
    );
  }

  // One row per (customer, bank, account), carrying the EARLIEST settlement —
  // the oldest evidence the customer controls that account, and the timestamp
  // that puts the destination furthest outside its cooling-off window.
  const rows = await packs.listSettledPayoutDestinations();
  if (rows.length === 0) {
    logger.info(
      '[backfill-payout-destinations] no settled payouts — nothing to do.',
    );
    return;
  }

  const byCustomer = new Map<string, SettledDestination[]>();
  for (const row of rows) {
    // Coerce at the boundary — see SettledDestination.first_settled_at.
    const settledAt = new Date(row.first_settled_at);
    if (Number.isNaN(settledAt.getTime())) {
      logger.warn(
        `[backfill-payout-destinations] customer ${row.customer_id}: unreadable settlement time for ${row.bank_code}; skipped.`,
      );
      continue;
    }
    const list = byCustomer.get(row.customer_id) ?? [];
    list.push({ ...row, first_settled_at: settledAt });
    byCustomer.set(row.customer_id, list);
  }

  let stamped = 0;
  let added = 0;
  let skippedAtCap = 0;
  let untouched = 0;

  for (const [customerId, destinations] of byCustomer) {
    // Oldest settlement first, so a customer over the cap keeps the
    // destinations they have used longest.
    destinations.sort(
      (a, b) => a.first_settled_at.getTime() - b.first_settled_at.getTime(),
    );

    // Per-customer tallies, folded into the run totals only AFTER the write
    // commits. The mutate callback runs before the UPDATE, so incrementing the
    // run totals inside it would report destinations as added or stamped even
    // when mutateCustomerMetadata then threw — and the file header tells the
    // operator to read "0 stamped, 0 added" as "the backfill is complete".
    let customerStamped = 0;
    let customerAdded = 0;
    let customerSkippedAtCap = 0;
    let customerUntouched = 0;

    try {
      await packs.mutateCustomerMetadata({
        customerId,
        mutate: (metadata) => {
          const accounts = parseSavedBankAccounts(metadata.bank_accounts);
          let changed = false;

          for (const destination of destinations) {
            const id = savedBankAccountId(
              destination.bank_code,
              destination.account_number,
            );
            const savedAt = destination.first_settled_at.toISOString();
            const existing = accounts.findIndex((a) => a.id === id);

            if (existing >= 0) {
              const current = accounts[existing] as SavedBankAccount;
              // Already stamped (by the live route or an earlier run): leave it
              // exactly as it is. This is what makes a re-run a no-op.
              if (typeof current.savedAt === 'string') continue;
              accounts[existing] = { ...current, savedAt };
              customerStamped += 1;
              changed = true;
              continue;
            }

            if (accounts.length >= MAX_SAVED_BANK_ACCOUNTS) {
              customerSkippedAtCap += 1;
              continue;
            }
            accounts.push({
              id,
              bankCode: destination.bank_code,
              bankName:
                bankNames.get(destination.bank_code) ?? destination.bank_code,
              accountNumber: destination.account_number,
              accountHolderName: destination.account_holder_name,
              savedAt,
            });
            customerAdded += 1;
            changed = true;
          }

          // null = nothing changed, so no write is issued.
          if (!changed) {
            customerUntouched += 1;
            return null;
          }
          return { ...metadata, bank_accounts: accounts };
        },
      });
      stamped += customerStamped;
      added += customerAdded;
      skippedAtCap += customerSkippedAtCap;
      untouched += customerUntouched;
    } catch (error) {
      // One unreadable customer (deleted mid-run, say) must not abandon the
      // rest; the summary is the operator's signal to re-run, which is safe.
      logger.warn(
        `[backfill-payout-destinations] customer ${customerId} skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  logger.info(
    `[backfill-payout-destinations] ${byCustomer.size} customer(s) with settled payouts: ` +
      `${added} destination(s) added, ${stamped} existing saved account(s) stamped, ` +
      `${skippedAtCap} skipped at the ${MAX_SAVED_BANK_ACCOUNTS}-account cap, ` +
      `${untouched} customer(s) already complete. Done.`,
  );
}
