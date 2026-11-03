import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import {
  bankCurrency,
  findBank,
  sandboxOnlyBank,
} from '../../../../../modules/packs/banks';
import { resolveActiveGateway } from '../../../../../modules/packs/gateway';
import {
  regionalPayoutGateways,
  withdrawalDetailsError,
  payoutCurrencyFor,
} from '../../../../../modules/packs/gateway-withdrawal';
import {
  resolvePacks,
  type CustomerWallet,
} from '../../../../../modules/packs/facets';
import {
  BANK_ACCOUNT_LOCKED_MESSAGE,
  BANNED_PAYOUT_ACCOUNT_MESSAGE,
  HOLDER_NAME_CONFIRM_MESSAGE,
  HOLDER_NAME_INVALID_MESSAGE,
  HOLDER_NAME_LINKED_MESSAGE,
  MAX_SAVED_BANK_ACCOUNTS,
  ONE_BANK_ACCOUNT_MESSAGE,
  SHARED_PAYOUT_ACCOUNT_MESSAGE,
  SHARED_SAVE_MESSAGE,
  anySavedAccountShared,
  blocksNewSave,
  holderConfirmMismatch,
  holderNameInvalid,
  newSavedBankAccount,
  normalizeHolderName,
  parseSavedBankAccounts,
  savedBankAccountId,
  savedBankAccountViews,
  verifiedBankAccounts,
  type SavedBankAccount,
} from '../../../../../modules/packs/saved-accounts';
import { sendSavedAccountAddedNotice } from '../../../../../modules/packs/saved-account-notice';
import {
  channelStatus,
  destinationMinRm,
  isTngBank,
  tngPausedReason,
} from '../../../../../modules/packs/withdrawal-controls';

// Saved payout bank accounts — GET (list) / POST (add) on
// /store/credits/withdraw/accounts. Storage is customer.metadata.bank_accounts,
// merged read-modify-write like the avatar/frame routes. DELETE only refuses:
// once tied, an account changes through support (ADR 0015, the admin
// customers/:id/bank-accounts routes).
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
// The write goes through
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
  SHARED_PAYOUT_ACCOUNT_MESSAGE,
  SHARED_SAVE_MESSAGE,
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

/** Read-only blob for GET. The write path does its own read INSIDE the lock. */
async function loadMetadata(
  req: AuthenticatedMedusaRequest,
  customerId: string,
): Promise<Record<string, unknown>> {
  const customers = req.scope.resolve(Modules.CUSTOMER);
  const customer = await customers.retrieveCustomer(
    requireCustomerId(customerId),
  );
  return (customer.metadata ?? {}) as Record<string, unknown>;
}

/**
 * Run `mutate` against this customer's metadata under the
 * `metadata:<customer>` advisory lock and return the blob as it was actually
 * written — never as the caller hoped to write it.
 */
async function mutateAccounts(
  req: AuthenticatedMedusaRequest,
  customerId: string,
  mutate: (accounts: SavedBankAccount[]) => SavedBankAccount[] | null,
): Promise<Record<string, unknown>> {
  const packs = resolvePacks<CustomerWallet>(req.scope);
  return await packs.mutateCustomerMetadata({
    customerId: requireCustomerId(customerId),
    mutate: (current) => {
      const next = mutate(parseSavedBankAccounts(current.bank_accounts));
      return next === null ? null : { ...current, bank_accounts: next };
    },
  });
}

/**
 * Every response here carries full account numbers, so none of them may land
 * in a shared/browser cache (CWE-525). POST echoes the same list GET serves.
 */
function noStore(res: MedusaResponse): MedusaResponse {
  res.setHeader('Cache-Control', 'no-store');
  return res;
}

/**
 * The store view of a saved list: payable-or-not against the active gateway
 * AND any open regional one, plus the currency the bank is paid in (SGD for a
 * Singapore bank via A3Pay), so the withdraw form can show what arrives. A
 * shared account reads as on hold, with what to do, ahead of the payout refusal.
 */
async function accountViews(
  req: AuthenticatedMedusaRequest,
  customerId: string,
  metadata: Record<string, unknown>,
) {
  const accounts = parseSavedBankAccounts(metadata.bank_accounts);
  const packs = resolvePacks<CustomerWallet>(req.scope);
  const onHold = await anySavedAccountShared(
    packs,
    customerId,
    accounts,
    verifiedBankAccounts(metadata),
  );
  const active = await resolveActiveGateway(req.scope);
  // The admin's Touch 'n Go switch and floor (withdrawal-controls.ts), so the
  // form shows a paused TNG account as such and states the right minimum.
  const controls = await packs.withdrawalControls();
  const tng = channelStatus(controls.tng, Date.now());
  return savedBankAccountViews(
    accounts,
    active,
    undefined,
    regionalPayoutGateways(),
  ).map((view) => {
    const invalid = withdrawalDetailsError(view);
    return {
      ...view,
      currency: payoutCurrencyFor(view.bankCode, active),
      ...(isTngBank(view.bankCode)
        ? {
            minRm: destinationMinRm(view.bankCode, controls),
            ...(tng.open
              ? {}
              : {
                  supported: false,
                  unavailableReason: tngPausedReason(tng.reopens_at),
                }),
          }
        : {}),
      ...(invalid
        ? {
            supported: false,
            unavailableReason: findBank(view.bankCode)?.accountLengths?.length
              ? `${invalid} Contact support to change it to the correct bank country and account number.`
              : `${invalid} Contact support to change it.`,
          }
        : {}),
      ...(onHold
        ? { supported: false, unavailableReason: SHARED_PAYOUT_ACCOUNT_MESSAGE }
        : {}),
    };
  });
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const metadata = await loadMetadata(req, req.auth_context.actor_id);
  noStore(res).json({
    accounts: await accountViews(req, req.auth_context.actor_id, metadata),
  });
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = requireCustomerId(req.auth_context.actor_id);
  const body = (req.body ?? {}) as {
    bank_code?: unknown;
    account_number?: unknown;
    account_holder_name?: unknown;
    account_holder_name_confirm?: unknown;
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
  // The picker hands out canonical bank ids (banks.ts); any gateway's own
  // code is accepted as an alias and normalised, so a saved account never
  // depends on which gateway was active when it was saved. An unknown bank
  // is refused: nothing could ever pay to it.
  const bank = findBank(body.bank_code as string);
  if (
    !bank ||
    sandboxOnlyBank(bank.id, process.env, await resolveActiveGateway(req.scope))
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Pick a bank from the list.',
    );
  }
  const account = newSavedBankAccount(
    bank,
    body.account_number as string,
    normalizeHolderName((body.account_holder_name as string | undefined) ?? ''),
  );
  const { accountNumber, bankCode } = account;
  if (
    holderConfirmMismatch({
      bank,
      holderName: account.accountHolderName,
      holderConfirm: body.account_holder_name_confirm,
    })
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      HOLDER_NAME_CONFIRM_MESSAGE,
    );
  }
  if (!bank.wallet && holderNameInvalid(account.accountHolderName)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      HOLDER_NAME_INVALID_MESSAGE,
    );
  }
  const packs = resolvePacks<CustomerWallet>(req.scope);
  if (
    await packs.payoutAccountBanned(accountNumber, bank.wallet !== undefined)
  ) {
    req.scope
      .resolve('logger')
      .warn(
        `[saved-accounts] refused a banned payout account for ${customerId} (${bankCode} …${accountNumber.slice(-4)})`,
      );
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      BANNED_PAYOUT_ACCOUNT_MESSAGE,
    );
  }
  const nameLinked = async () =>
    !bank.wallet &&
    (await packs.holderNameHeldByAnother(
      customerId,
      account.accountHolderName,
    ));
  const refuseLinkedName = (): never => {
    // Logged like a shared number, so a run of probes shows up. No name: PII.
    req.scope
      .resolve('logger')
      .warn(
        `[saved-accounts] refused a holder name another account used, for ${customerId}`,
      );
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      HOLDER_NAME_LINKED_MESSAGE,
    );
  };
  if (await nameLinked()) refuseLinkedName();

  // Looked up before the lock (it reads OTHER customers, which this
  // customer's metadata lock does not cover) but applied inside it, where
  // "already on my list" is decided from the locked read. Two strangers saving
  // one number in the same instant can both get through, and are both held at
  // payout, which sees the other's saved entry.
  //
  // Any holder blocks, under any name: one ring typed ten holder names onto one
  // number, which the old same-name rule let straight through. A stranger who
  // saves someone's number first locks the owner out until support acts; support
  // is the answer to that (ADR 0015). Support's verification lifts a payout hold
  // on a number already saved; it never lets a new one in.
  const shared = blocksNewSave(
    await packs.otherPayoutAccountHolders(
      customerId,
      accountNumber,
      bank.wallet !== undefined,
    ),
    bankCode,
  );

  // The cap is checked against the list read INSIDE the lock, not against one
  // this handler read earlier — otherwise two concurrent saves could both see
  // MAX-1 accounts and both be allowed through.
  let added = false;
  const saved = await mutateAccounts(req, customerId, (accounts) => {
    // Already theirs: nothing to do. A saved account cannot be changed, its
    // holder name included, and keeps its original savedAt, so a re-save restarts
    // no cooling-off window and arms no old row.
    if (accounts.some((a) => a.id === account.id)) return null;
    const currency = bankCurrency(bankCode);
    if (
      accounts.filter((a) => bankCurrency(a.bankCode) === currency).length >=
      MAX_SAVED_BANK_ACCOUNTS
    ) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        ONE_BANK_ACCOUNT_MESSAGE,
      );
    }
    if (shared) {
      // The refusal tells the customer the number is linked elsewhere; log
      // it so repeated probing for linked numbers shows up. Last 4 only.
      req.scope
        .resolve('logger')
        .warn(
          `[saved-accounts] refused a shared payout account for ${customerId} (${bankCode} …${accountNumber.slice(-4)})`,
        );
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, SHARED_SAVE_MESSAGE);
    }
    added = true;
    return [...accounts, account];
  });
  // The name lookup reads other customers, which this customer's lock does not
  // cover, so two accounts saving one name at once both pass it. Look again now
  // the save is visible: a racer takes its entry back off. Both racers may, and
  // the next try is serial.
  if (added && (await nameLinked())) {
    await mutateAccounts(req, customerId, (accounts) =>
      accounts.filter((a) => a.id !== account.id),
    );
    refuseLinkedName();
  }

  // A NEW payout destination is the event worth telling the account owner
  // about: it is the first half of "steal a token, wait out the cooling-off,
  // cash out". Fired after the write has committed and never allowed to fail
  // the save (the helper swallows its own errors) — a dropped notice must not
  // cost the customer their saved account. Re-saving an account they already
  // had changes nothing, so it stays silent.
  if (added) {
    await sendSavedAccountAddedNotice(req.scope, {
      customerId,
      accountId: account.id,
      bankName: account.bankName,
      accountNumber: account.accountNumber,
      savedAt: account.savedAt as string,
    });
  }
  noStore(res).json({
    accounts: await accountViews(req, customerId, saved),
  });
}

// Kept so a page opened before this rule shipped gets the reason, not a 404.
export async function DELETE(
  req: AuthenticatedMedusaRequest,
  _res: MedusaResponse,
): Promise<void> {
  requireCustomerId(req.auth_context.actor_id);
  throw new MedusaError(
    MedusaError.Types.NOT_ALLOWED,
    BANK_ACCOUNT_LOCKED_MESSAGE,
  );
}
