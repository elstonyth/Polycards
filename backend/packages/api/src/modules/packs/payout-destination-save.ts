import type {
  ContainerLike,
  ICustomerModuleService,
  Logger,
} from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { findBank, sandboxOnlyBank, savedAccountSlot } from './banks';
import { resolvePacks, type PayoutDestinations } from './facets';
import { resolveActiveGateway } from './gateway';
import { withdrawalDetailsError } from './gateway-withdrawal';
import { saveVerdict, type NumberStanding } from './payout-destination';
import { sendSavedAccountAddedNotice } from './saved-account-notice';
import type { Bank } from './banks';
import {
  BANNED_PAYOUT_ACCOUNT_MESSAGE,
  HOLDER_NAME_DIFFERENT_MESSAGE,
  HOLDER_NAME_LINKED_MESSAGE,
  ONE_BANK_ACCOUNT_MESSAGE,
  ONE_TNG_ACCOUNT_MESSAGE,
  REAL_NAME_CHANGED_MESSAGE,
  REAL_NAME_NEEDED_MESSAGE,
  REAL_NAME_NOT_HOLDER_MESSAGE,
  SHARED_SAVE_MESSAGE,
  holderMatchKey,
  newSavedBankAccount,
  parseSavedBankAccounts,
  realNameHolder,
  type SavedBankAccount,
} from './saved-accounts';

// Saving a Payout Destination (ADR 0015: one per account), for the customer's
// own save (POST /store/credits/withdraw/accounts) and support's add (POST
// /admin/customers/:id/bank-accounts/add). The routes map HTTP to this and
// back; the order, the lock, the re-checks after the write, their undo and the
// owner's notice live here, so the two saves cannot drift apart.
//
// Its own file, not payout-destination.ts or saved-accounts.ts: it needs
// withdrawalDetailsError and resolveActiveGateway, whose modules import those
// two (and, through gateway.ts, the service), so either home would be a cycle.
//
// Both actors, in this order:
//   1. The holder is the account's real name (owner, 2026-11-16), read only for
//      a bank (a wallet has no holder). None, or not in English letters: refused.
//   2. withdrawalDetailsError, the payout submit's own gate.
//   3. A bank from the registry, and not the sandbox one outside the sandbox.
//   4. The ban list, for this player (support unbans per player). Support's add
//      is refused too (owner, 2026-11-03).
//   5. The write, under the `metadata:<customer>` lock.
//   6. The real name again: it was read before the lock, so a correction may
//      have landed since. A bank left in the old name comes back off.
//   7. The owner's notice, only for an entry really added.
//
// Where the actors differ, on purpose:
//
//   | rule                                  | customer            | support                          |
//   | ------------------------------------- | ------------------- | -------------------------------- |
//   | refusal copy (real name, slot)        | the customer's      | staff's                          |
//   | refusals logged (probing shows up)    | yes                 | no                               |
//   | name another account used (step 4b)   | refused             | not checked (decision 2026-11-15)|
//   | already on the list                   | no-op success       | the slot refusal                 |
//   | one name on every bank                | refused             | not checked                      |
//   | number another account holds          | refused             | added, verified (ADR 0015)       |
//   | ... while another is verified on it   | refused             | refused, naming that account     |
//   | after the write: name or number race  | re-checked, undone  | not checked                      |
//   | step 6 undo                           | keeps an entry the  | always takes it back, audited    |
//   |                                       | correction carried  | (removeSavedBankAccount)         |
//
// Support's add is the override for a real owner whose number another account
// holds: support checked the person, so it vouches for the number by adding it.

/** Who saves. Support names the admin (from the token) and the audited reason. */
export type CustomerActor = { kind: 'customer' };
export type SupportActor = { kind: 'support'; adminId: string; reason: string };
export type SaveActor = CustomerActor | SupportActor;

/** A customer save: whether an entry was added (an account already saved
 *  changes nothing), and the metadata as it was actually written. */
export type CustomerSaved = {
  added: boolean;
  metadata: Record<string, unknown>;
};

export type SaveInput<A extends SaveActor = SaveActor> = {
  /** The account the bank is saved on: the token's customer, or the player
   *  support is on. Never empty (the store route 401s first). */
  customerId: string;
  actor: A;
  /** As the request sent them, unchecked. */
  bankCode: unknown;
  accountNumber: unknown;
};

const REAL_NAME_REFUSALS = {
  customer: {
    none: REAL_NAME_NEEDED_MESSAGE,
    notLetters: REAL_NAME_NOT_HOLDER_MESSAGE,
  },
  support: {
    none: 'This player has no real name on file. A bank account is saved in the real name: set it first.',
    notLetters:
      "This player's real name is not in English letters, so a bank account cannot carry it. Correct the real name first.",
  },
} as const;

function refuse(message: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, message);
}

/**
 * Save one Payout Destination for `customerId` as `actor`. Throws the
 * refusal (MedusaError, the routes' status and copy) or returns:
 *   customer: `added` (false for an account already saved, which changes
 *             nothing) and the metadata as it was actually written;
 *   support:  `added: true`.
 */
export async function savePayoutDestination(
  scope: ContainerLike,
  input: SaveInput<CustomerActor>,
): Promise<CustomerSaved>;
export async function savePayoutDestination(
  scope: ContainerLike,
  input: SaveInput<SupportActor>,
): Promise<{ added: true }>;
export async function savePayoutDestination(
  scope: ContainerLike,
  input: SaveInput,
): Promise<{ added: boolean; metadata?: Record<string, unknown> }> {
  const { customerId, actor } = input;
  const packs = resolvePacks<PayoutDestinations>(scope);

  // 1. One name per account (owner, 2026-11-16): a bank's holder IS the
  // account's real name, never typed. No real name, or one not in English
  // letters, and no bank can be saved: support corrects the real name. A
  // wallet has no holder, so it never asks.
  const picked =
    typeof input.bankCode === 'string' ? findBank(input.bankCode) : undefined;
  let holderName = '';
  if (picked && !picked.wallet) {
    const { realName } = await packs.getVerificationState(customerId);
    const holder = realNameHolder(realName);
    if (!holder) {
      const copy = REAL_NAME_REFUSALS[actor.kind];
      refuse(realName?.trim() ? copy.notLetters : copy.none);
    }
    holderName = holder;
  }

  // 2. Same gate as the payout submit, so the saved list can never hold an
  // account the withdraw path would refuse.
  const invalid = withdrawalDetailsError({
    bankCode: input.bankCode,
    accountNumber: input.accountNumber,
    accountHolderName: holderName,
  });
  if (invalid) throw new MedusaError(MedusaError.Types.INVALID_DATA, invalid);

  // 3. The picker hands out canonical bank ids (banks.ts); any gateway's own
  // code is accepted as an alias and normalised, so a saved account never
  // depends on which gateway was active when it was saved. An unknown bank
  // is refused: nothing could ever pay to it.
  const bank = findBank(input.bankCode as string);
  if (
    !bank ||
    sandboxOnlyBank(bank.id, process.env, await resolveActiveGateway(scope))
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Pick a bank from the list.',
    );
  }
  // Stored the same whoever saves it, so the one-name rule sees support's
  // entries too.
  const account = newSavedBankAccount(
    bank,
    input.accountNumber as string,
    holderName,
  );
  // 4. Every spelling (a PayNow mobile with or without its 65), at this bank.
  const destination = {
    bankCode: account.bankCode,
    accountNumber: account.accountNumber,
  };
  const number = await packs.payoutNumberStanding(customerId, destination);

  const step = { scope, packs, customerId, bank, account, holderName, number };
  return actor.kind === 'customer'
    ? await saveAsCustomer(step)
    : await saveAsSupport({ ...step, actor });
}

/** What every save has settled before the write: the checked bank and the
 *  entry to add, its holder, and the number's standing. */
type CheckedSave = {
  scope: ContainerLike;
  packs: PayoutDestinations;
  customerId: string;
  bank: Bank;
  account: SavedBankAccount;
  /** The real name the bank carries; '' for a wallet. */
  holderName: string;
  number: NumberStanding;
};

/** The owner's notice of a new destination (saved-account-notice.ts). Fired
 *  after the write has committed and never allowed to fail the save (the
 *  helper swallows its own errors): a dropped notice must not cost the
 *  customer their saved account. */
const sendAddedNotice = (
  scope: ContainerLike,
  customerId: string,
  a: SavedBankAccount,
) =>
  sendSavedAccountAddedNotice(scope, {
    customerId,
    accountId: a.id,
    bankName: a.bankName,
    accountNumber: a.accountNumber,
    savedAt: a.savedAt as string,
  });

/** The match key of the account's real name as it is now ('' for none, or
 *  one no bank can carry): read again after the write, since a correction may
 *  have landed after the holder name was read. */
async function realNameKeyNow(
  packs: PayoutDestinations,
  customerId: string,
): Promise<string> {
  const now = realNameHolder(
    (await packs.getVerificationState(customerId)).realName,
  );
  return now ? holderMatchKey(now) : '';
}

async function saveAsCustomer(save: CheckedSave): Promise<CustomerSaved> {
  const { scope, packs, customerId, bank, account, holderName, number } = save;
  const { accountNumber, bankCode } = account;
  const warn = (line: string) => scope.resolve<Logger>('logger').warn(line);
  // Run `mutate` on the saved list read INSIDE the `metadata:<customer>` lock,
  // and return the blob as it was actually written, never as hoped.
  const mutateAccounts = (
    mutate: (accounts: SavedBankAccount[]) => SavedBankAccount[] | null,
  ) =>
    packs.mutateCustomerMetadata({
      customerId,
      mutate: (current) => {
        const next = mutate(parseSavedBankAccounts(current.bank_accounts));
        return next === null ? null : { ...current, bank_accounts: next };
      },
    });

  if (number.bannedForPlayer) {
    warn(
      `[saved-accounts] refused a banned payout account for ${customerId} (${bankCode} …${accountNumber.slice(-4)})`,
    );
    refuse(BANNED_PAYOUT_ACCOUNT_MESSAGE);
  }
  // 4b. A holder name another account used. Compared by its letters
  // (holderNameKey, on both sides in the query), so a name dressed up with
  // digits, accents or small capitals is the plain one. A wallet has no holder
  // name.
  const destination = { bankCode, accountNumber };
  const nameNow = async () =>
    bank.wallet
      ? null
      : await packs.payoutNameStanding(customerId, account.accountHolderName);
  const refuseLinkedName = (): never => {
    // Logged like a shared number, so a run of probes shows up. No name: PII.
    warn(
      `[saved-accounts] refused a holder name another account used, for ${customerId}`,
    );
    return refuse(HOLDER_NAME_LINKED_MESSAGE);
  };
  const name = await nameNow();
  if (name && name.blocking.length > 0) refuseLinkedName();

  // Looked up before the lock (it reads OTHER customers, which this
  // customer's metadata lock does not cover) but applied inside it, where
  // "already on my list" is decided from the locked read. Two strangers saving
  // one number in the same instant both pass it, so it is asked again once the
  // save is visible (below).
  //
  // Any holder blocks, under any name: one ring typed ten holder names onto one
  // number, which the old same-name rule let straight through. A stranger who
  // saves someone's number first locks the owner out until support acts; support
  // is the answer to that (ADR 0015). Support's verification lifts a payout hold
  // on a number already saved; it never lets a new one in.
  const verdict = (standing: NumberStanding, accounts: SavedBankAccount[]) =>
    saveVerdict({
      number: standing,
      name,
      saved: accounts,
      accountId: account.id,
      holderName: account.accountHolderName,
    });
  const refuseShared = (): never => {
    // The refusal tells the customer the number is linked elsewhere; log it so
    // repeated probing for linked numbers shows up. Last 4 only.
    warn(
      `[saved-accounts] refused a shared payout account for ${customerId} (${bankCode} …${accountNumber.slice(-4)})`,
    );
    return refuse(SHARED_SAVE_MESSAGE);
  };

  // 5. The cap is checked against the list read INSIDE the lock, not against
  // one read earlier — otherwise two concurrent saves could both see MAX-1
  // accounts and both be allowed through.
  let added = false;
  let saved = await mutateAccounts((accounts) => {
    const { alreadySaved, blocks } = verdict(number, accounts);
    // Already theirs: nothing to do. A saved account cannot be changed, its
    // holder name included, and keeps its original savedAt, so a re-save restarts
    // no cooling-off window and arms no old row.
    if (alreadySaved) return null;
    if (blocks.includes('slot_full')) {
      refuse(
        savedAccountSlot(bankCode) === 'TNG'
          ? ONE_TNG_ACCOUNT_MESSAGE
          : ONE_BANK_ACCOUNT_MESSAGE,
      );
    }
    // One name on every bank (holderUnlikeSaved): an older saved bank in
    // another name than the real name.
    if (blocks.includes('name_unlike_saved')) {
      // Logged like the other refusals, so repeated tries show up. No name.
      warn(
        `[saved-accounts] refused a holder name unlike the saved one, for ${customerId}`,
      );
      refuse(HOLDER_NAME_DIFFERENT_MESSAGE);
    }
    if (blocks.includes('shared')) refuseShared();
    added = true;
    return [...accounts, account];
  });
  // 6. The real name was read before the lock, so support may have corrected
  // it since. Read it again: a bank left in the old name comes back off. One
  // the correction already carried to the new name stays.
  if (added && holderName) {
    const nowKey = await realNameKeyNow(packs, customerId);
    if (nowKey !== holderMatchKey(holderName)) {
      let kept = false;
      saved = await mutateAccounts((accounts) => {
        const entry = accounts.find((a) => a.id === account.id);
        kept =
          !!entry &&
          nowKey !== '' &&
          holderMatchKey(entry.accountHolderName) === nowKey;
        return kept ? null : accounts.filter((a) => a.id !== account.id);
      });
      if (!kept) refuse(REAL_NAME_CHANGED_MESSAGE);
    }
  }
  // The name and number lookups read other customers, which this customer's
  // lock does not cover, so two accounts saving one name or one number at once
  // both pass them. Look again now the save is visible: a racer takes its entry
  // back off. Both racers may, and the next try is serial.
  if (added) {
    const linked = ((await nameNow())?.blocking.length ?? 0) > 0;
    if (
      linked ||
      verdict(
        await packs.payoutNumberStanding(customerId, destination),
        [],
      ).blocks.includes('shared')
    ) {
      await mutateAccounts((accounts) =>
        accounts.filter((a) => a.id !== account.id),
      );
      if (linked) refuseLinkedName();
      refuseShared();
    }
  }

  // 7. A NEW payout destination is the event worth telling the account owner
  // about: it is the first half of "steal a token, wait out the cooling-off,
  // cash out". Re-saving an account they already had changes nothing, so it
  // stays silent.
  if (added) await sendAddedNotice(scope, customerId, account);
  return { added, metadata: saved };
}

async function saveAsSupport(
  save: CheckedSave & { actor: SupportActor },
): Promise<{ added: true }> {
  const { scope, packs, customerId, account, holderName, number, actor } = save;
  // A banned number stays banned, support's add included (owner, 2026-11-03).
  if (number.bannedForPlayer) refuse(BANNED_PAYOUT_ACCOUNT_MESSAGE);
  // One person, one account: support vouches for a shared number by adding it,
  // so it arrives verified, unless another account already is.
  const verifiedId = number.holders.find((h) => h.verified)?.customerId;
  if (verifiedId) {
    const [other] = await scope
      .resolve<ICustomerModuleService>(Modules.CUSTOMER)
      .listCustomers(
        { id: [verifiedId] },
        { select: ['id', 'metadata'], take: 1 },
      );
    refuse(
      `One person, one account: ${other?.metadata?.handle ?? verifiedId} is already verified on this bank account. Undo that first if this is the right account.`,
    );
  }

  // 5. Under the lock, with its audit row; the slot is checked there.
  await packs.addSavedBankAccount({
    customerId,
    adminId: actor.adminId,
    account,
    verify: number.holders.length > 0,
    reason: actor.reason,
  });
  // 6. The real name was read before the add's lock: a correction landing in
  // between would leave the bank in the old name. Take it back (its own audit
  // row) and let support try again.
  if (
    holderName &&
    (await realNameKeyNow(packs, customerId)) !== holderMatchKey(holderName)
  ) {
    await packs.removeSavedBankAccount({
      customerId,
      adminId: actor.adminId,
      accountId: account.id,
      reason: 'the real name changed during the add',
    });
    refuse(
      'The real name changed while this bank account was being added, so it was not added. Try again.',
    );
  }
  // 7. A new payout destination is a security event whoever adds it.
  await sendAddedNotice(scope, customerId, account);
  return { added: true };
}
