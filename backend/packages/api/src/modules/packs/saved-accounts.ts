import { createHash } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import {
  accountNumberForms,
  bankPayoutMinRm,
  findBank,
  gatewayBankCode,
  sandboxOnlyBank,
  savedAccountSlot,
  type Bank,
} from './banks';
// Type-only: a value import of gateway.ts from here would cycle through the
// module index into the service, which imports this file.
import type { PaymentGateway } from './gateway';
import { realNameKey } from '../../utils/real-name';

// The customer's saved payout destinations — the shape, the deterministic id,
// the defensive parse, and the cooling-off rule that decides whether one may
// receive money yet.
//
// Lives in the module layer (not in the API route that owns the CRUD) because
// three callers need it and they must agree exactly: the saved-accounts route,
// the payout money path (gateway-withdrawal.ts + PacksModuleService
// .withdrawForCashout), and the admin bank-accounts routes. A module file also
// keeps the money path from importing an API route.

/** One saved account per currency per Polycards account (owner, 2026-11-03, ADR
 *  0015): one RM bank, one Touch 'n Go, one SGD bank, one USDT wallet
 *  (savedAccountSlot). Once saved it cannot be changed. */
export const MAX_SAVED_BANK_ACCOUNTS = 1;

/** Is the list's slot for this bank (an RM bank, a Touch 'n Go, an SGD bank, a
 *  wallet: savedAccountSlot) full? The customer save refuses then; support
 *  removes one first. Shared with the admin assistant's bank_save_check. */
export function savedSlotFull(
  accounts: SavedBankAccount[],
  bankCode: string,
): boolean {
  const slot = savedAccountSlot(bankCode);
  return (
    accounts.filter((a) => savedAccountSlot(a.bankCode) === slot).length >=
    MAX_SAVED_BANK_ACCOUNTS
  );
}

/** One name on every bank (owner, 2026-11-03): a new bank, Touch 'n Go or
 *  another country's bank must carry a holder name already saved, compared by
 *  holderNameKey. Wallets have no holder. Any saved name will do, since
 *  support's add, the way past this for a name two banks spell differently,
 *  may leave two on the list. Shared with the admin assistant's
 *  bank_save_check. */
export function holderUnlikeSaved(
  accounts: SavedBankAccount[],
  bankCode: string,
  holderName: string,
): boolean {
  if (findBank(bankCode)?.wallet) return false;
  // A name saved before this key with no English letters keys empty; it keeps
  // its old key, so its owner is still held to it rather than let off.
  const key = (n: string) => holderNameKey(n) || realNameKey(n);
  const savedNames = accounts
    .filter((a) => !findBank(a.bankCode)?.wallet)
    .map((a) => key(a.accountHolderName ?? ''))
    .filter(Boolean);
  return savedNames.length > 0 && !savedNames.includes(key(holderName));
}

export const ONE_BANK_ACCOUNT_MESSAGE =
  'Your Polycards account already has a bank account for this currency. It cannot be changed.';

/** A second Touch 'n Go: it has its own slot beside the RM bank. */
export const ONE_TNG_ACCOUNT_MESSAGE =
  "Your Polycards account already has a Touch 'n Go account. It cannot be changed.";

export const BANK_ACCOUNT_LOCKED_MESSAGE =
  'A saved bank account cannot be removed or changed.';

/** The farm rings' numbers, banned for good (owner, 2026-11-03). The list lives
 *  in the banned_payout_account table only: the repo is public. */
export const BANNED_PAYOUT_ACCOUNT_MESSAGE =
  'This bank account cannot be used on Polycards.';

/** disabled_reason prefix of a permanent ban for breaking the rules (owner,
 *  2026-11-03: shared banks, more than one account). The login guard gives it
 *  its own message; lifting one clears the saved banks (liftPermanentBan). */
export const PERMANENT_BAN_REASON_PREFIX = 'Permanent ban:';

export const HOLDER_NAME_CONFIRM_MESSAGE =
  'The two names do not match. Type the same name twice.';

/** A different bank under a name another account already used (owner,
 *  2026-11-03). */
export const HOLDER_NAME_LINKED_MESSAGE =
  'This name is already linked to another Polycards account. If you are a different person with the same name, contact support.';

/** A bank or Touch 'n Go under another name than the one already saved on
 *  this account (owner, 2026-11-03): one account, one person, one name. */
export const HOLDER_NAME_DIFFERENT_MESSAGE =
  'Use the same account holder name as your saved bank account. All bank accounts on one Polycards account must be in one name. If your banks spell your name differently, contact support.';

export const HOLDER_NAME_INVALID_MESSAGE =
  'Enter the account holder name in English letters, exactly as your bank shows it.';

/** A bank holder name as stored and compared: NFKC, invisible format characters
 *  dropped, any run of Unicode spaces one space. Look-alike spellings of one
 *  name must not pass the one-name rule as different names. */
export function normalizeHolderName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim();
}

// Latin small capitals have no compatibility decomposition, so NFKD leaves
// them; they fold by hand. No small capital X is encoded.
export const SMALL_CAPS = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘꞯʀꜱᴛᴜᴠᴡʏᴢ';
export const SMALL_CAP_LETTERS = 'abcdefghijklmnopqrstuvwyz';
const SMALL_CAP_RE = new RegExp(`[${SMALL_CAPS}]`, 'gu');

// Letters NFKD does not break down, written as the English letters they
// read as (a name typed with Đ or ß is the same person's), and the look-alikes
// ı and ɑ. Kept in step with the SQL key in service.ts (holderNameKeySql).
export const LETTER_FOLDS: Readonly<Record<string, string>> = {
  đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', ł: 'l', Ł: 'L', ø: 'o', Ø: 'O',
  ħ: 'h', Ħ: 'H', ŧ: 't', Ŧ: 'T', ı: 'i', ɑ: 'a',
  ß: 'ss', ẞ: 'SS', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', þ: 'th', Þ: 'TH',
};
const LETTER_FOLD_RE = new RegExp(`[${Object.keys(LETTER_FOLDS).join('')}]`, 'gu');

/** A name's letters as they read: NFKD, marks dropped, small capitals and the
 *  letters above folded. */
const foldLatin = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(SMALL_CAP_RE, (c) => SMALL_CAP_LETTERS[SMALL_CAPS.indexOf(c)])
    .replace(LETTER_FOLD_RE, (c) => LETTER_FOLDS[c]);

/** The key holder names compare by: its letters only, lower case. Digits,
 *  punctuation, accents and small capitals do not make another name. */
export const holderNameKey = (name: string): string =>
  foldLatin(name).toLowerCase().replace(/[^a-z]/g, '');

// Latin letters (accents included), digits and the punctuation bank names
// carry. Other scripts are refused: a Cyrillic look-alike would read as the
// same name to staff and as a new one to the check.
const HOLDER_NAME_RE =
  /^[\p{Script=Latin}0-9][\p{Script=Latin}0-9 .'@/,&()-]*$/u;

/** Is this normalized holder name refused? It must hold at least one letter, or
 *  its comparison key would be empty and match nothing, and every letter must
 *  read as an English one once folded: one that does not would key apart from
 *  the name it copies. */
export function holderNameInvalid(name: string): boolean {
  return (
    !HOLDER_NAME_RE.test(name) ||
    !/\p{Script=Latin}/u.test(name) ||
    /(?![A-Za-z])\p{L}/u.test(foldLatin(name))
  );
}

/** A customer types a bank's holder name twice, and the two must match (owner,
 *  2026-11-03): a name that differs from the bank's is never paid out. A wallet
 *  has no holder. */
export function holderConfirmMismatch(args: {
  bank: Bank;
  holderName: string;
  holderConfirm: unknown;
}): boolean {
  if (args.bank.wallet) return false;
  const typed = (s: string) => normalizeHolderName(s).toLowerCase();
  return (
    typeof args.holderConfirm !== 'string' ||
    typed(args.holderConfirm) !== typed(args.holderName)
  );
}

/** How banned numbers are stored and matched: digits without leading zeros for a
 *  bank, at any bank, as otherPayoutAccountHolders compares them; a wallet
 *  address whole (an EVM one in lower case, as newSavedBankAccount stores it;
 *  a Tron address is case-sensitive). */
export function payoutAccountKey(
  accountNumber: string,
  wallet: false | 'tron' | 'evm' | boolean,
): string {
  if (!wallet) return accountNumber.replace(/\D/g, '').replace(/^0+/, '');
  return wallet === 'evm' ? accountNumber.toLowerCase() : accountNumber;
}

/** Does this list hold a bank, not only USDT wallets? The welcome pack and task
 *  rewards need one (owner, 2026-11-03): a fresh wallet costs nothing. */
export function includesBank(accounts: SavedBankAccount[]): boolean {
  return accounts.some((a) => findBank(a.bankCode)?.wallet === undefined);
}

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
   * NOT usable (see destinationUsableAt).
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
  /** The bank's own payout floor (RM) when it has one (Touch 'n Go: 100), so
   *  the form can state and check it; null = the gateway's floor applies. */
  minRm: number | null;
  /** A USDT wallet's chain (banks.ts), absent for a bank. */
  wallet?: string;
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
      // (the gateway's, historically). Read them as the canonical bank, with the
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
 * Read PER CALL (the plan-066 convention, same as GATEWAY_WD_DAILY_MAX_RM) so
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
 * window. A one-shot backfill (since retired) spared anyone who already withdrew.
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
  /** Regional gateways open beside the active one (regionalPayoutGateways). */
  regional: readonly PaymentGateway[] = [],
): SavedBankAccountView[] {
  return accounts.map((account) => {
    const usableAt = destinationUsableAt(account, cooldownHours);
    return {
      ...account,
      usableFrom: usableAt ? usableAt.toISOString() : null,
      supported: [gateway, ...regional].some((g) =>
        bankSupportedBy(account.bankCode, g),
      ),
      minRm: bankPayoutMinRm(account.bankCode),
      ...(findBank(account.bankCode)?.wallet
        ? { wallet: findBank(account.bankCode)?.wallet }
        : {}),
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
  env: Partial<Record<string, string>> = process.env,
): boolean {
  if (sandboxOnlyBank(bankCode, env, gateway)) return false;
  return Boolean(gatewayBankCode(bankCode, gateway, env));
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

  // The id is not a label, it is sha256(bankCode, accountNumber). This
  // re-derivation is a real check for a CANONICAL-coded entry — account.id
  // there is whatever was actually stored, verified against a freshly derived
  // value. For a LEGACY-coded entry it is not: parseSavedBankAccounts (lines
  // 93-99) already recomputed account.id as savedBankAccountId(bankCode,
  // accountNumber) at read time, so this comparison is against a value it
  // just derived and cannot fail for that entry. The legacy path is covered
  // instead by every writer computing the id correctly (the save route, the
  // admin add route) and by client-supplied metadata being refused
  // (middlewares.ts customer-write guards) — convention, not this enforcement.
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
      'This bank account was saved before withdrawal checks were added. Contact support to update it.',
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

/**
 * One bank account, one Polycards account (ADR 0015). A number another customer
 * saved or was paid to is refused when saving. At payout, any saved number that
 * is shared holds the whole account until support acts: verifies that number or
 * removes it. Existing shared accounts are held too: the clusters left alone on
 * 2026-10-14 were still being farmed.
 */
export const SHARED_PAYOUT_ACCOUNT_MESSAGE =
  'Your bank account is linked to another Polycards account. Contact support to verify it.';

/** The refusal when saving. Support can add it for its real owner (bank-accounts/add). */
export const SHARED_SAVE_MESSAGE =
  'This bank account is linked to another Polycards account. If it is yours, contact support.';

/** Does anyone else hold this destination, saved or paid? The same digits at
 *  another bank are a different account. */
export function heldByAnother(
  holders: { bank_code: string }[],
  bankCode: string,
): boolean {
  const bank = findBank(bankCode);
  return holders.some((h) => findBank(h.bank_code)?.id === bank?.id);
}

/** Has the customer saved a bank, not only a USDT wallet? The welcome pack needs
 *  one (owner, 2026-11-03): a bank number sits on one account only, while a fresh
 *  wallet costs nothing. Takes the customer's metadata. */
export function hasSavedBank(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return includesBank(parseSavedBankAccounts(metadata?.bank_accounts));
}

/** Does a new save of this destination get refused? Stricter than a hold on one
 *  point only: a wallet's address is public on-chain and has no holder name, so
 *  a stranger who merely saved it must not stop its owner saving it. Only one
 *  someone was already PAID to blocks (a payout row has a null holder_name). The
 *  payout check still sees the saved entry, so sharing a wallet earns no money. */
export function blocksNewSave(
  holders: { bank_code: string; holder_name?: string | null }[],
  bankCode: string,
): boolean {
  const bank = findBank(bankCode);
  return holders.some(
    (h) =>
      findBank(h.bank_code)?.id === bank?.id &&
      (!bank?.wallet || h.holder_name == null),
  );
}

/** Is any saved account that support has not verified held by someone else? The
 *  whole list counts, not only the one being paid: a second saved number must not
 *  be the way round a hold. Lists hold a handful of rows, so one lookup each is
 *  fine. */
export async function anySavedAccountShared(
  packs: {
    otherPayoutAccountHolders(
      customerId: string,
      accountNumber: string,
      exact?: boolean,
    ): Promise<{ bank_code: string }[]>;
  },
  customerId: string,
  accounts: SavedBankAccount[],
  verified: Record<string, string>,
): Promise<boolean> {
  const verdicts = await Promise.all(
    accounts
      .filter((a) => !verified[a.id])
      .map(async (a) =>
        heldByAnother(
          (
            await Promise.all(
              accountNumberForms(a.bankCode, a.accountNumber).map((n) =>
                packs.otherPayoutAccountHolders(
                  customerId,
                  n,
                  findBank(a.bankCode)?.wallet !== undefined,
                ),
              ),
            )
          ).flat(),
          a.bankCode,
        ),
      ),
  );
  return verdicts.some(Boolean);
}

/** customer.metadata key: saved account id to when support verified it. Per number,
 *  so it never vouches for another one on the list, and it goes when the account
 *  does. Lifts the payout hold, never the refusal to save. Only the admin
 *  bank-accounts routes write it: rejectCustomerMetadata and
 *  rejectAdminBankAccountsMetadata refuse it everywhere else. */
export const BANK_SHARE_VERIFIED_KEY = 'bank_share_verified';

export function verifiedBankAccounts(
  metadata: Record<string, unknown>,
): Record<string, string> {
  const stamps = metadata[BANK_SHARE_VERIFIED_KEY];
  if (typeof stamps !== 'object' || stamps === null) return {};
  return Object.fromEntries(
    Object.entries(stamps).filter(([, at]) => typeof at === 'string'),
  ) as Record<string, string>;
}

/** Holder names support cleared as a real clash (owner, 2026-11-04): another
 *  person with the same name holds it on another account, so this account's
 *  own saves stop counting THOSE accounts' use of it. `with` is who held it
 *  when support checked; an account that uses the name later still counts.
 *  Keyed by holderNameKey; only support writes it (setHolderNameCleared). */
export const HOLDER_NAME_CLEARED_KEY = 'holder_name_cleared';

export type ClearedHolderName = { name: string; at: string; with: string[] };

export function clearedHolderNames(
  metadata: Record<string, unknown>,
): Record<string, ClearedHolderName> {
  const stamps = metadata[HOLDER_NAME_CLEARED_KEY];
  // No prototype: a name keyed 'constructor' must not find Object's.
  const out = Object.create(null) as Record<string, ClearedHolderName>;
  if (typeof stamps !== 'object' || stamps === null) return out;
  // Keyed afresh from each stamp's own name, so one written under an older key
  // still matches what a save checks; two that now share a key share accounts.
  for (const v of Object.values(stamps)) {
    if (
      typeof v !== 'object' ||
      v === null ||
      typeof (v as ClearedHolderName).name !== 'string' ||
      typeof (v as ClearedHolderName).at !== 'string' ||
      !Array.isArray((v as ClearedHolderName).with)
    ) {
      continue;
    }
    const stamp = v as ClearedHolderName;
    const key = holderNameKey(stamp.name);
    const prev = out[key];
    out[key] = prev
      ? { ...stamp, with: [...new Set([...prev.with, ...stamp.with])] }
      : stamp;
  }
  return out;
}

/** The blob with one name cleared, or the clearing removed by a null. */
export function withClearedHolderName(
  metadata: Record<string, unknown>,
  key: string,
  stamp: ClearedHolderName | null,
): Record<string, unknown> {
  const { [key]: _old, ...others } = clearedHolderNames(metadata);
  const stamps = stamp === null ? others : { ...others, [key]: stamp };
  const { [HOLDER_NAME_CLEARED_KEY]: _key, ...rest } = metadata;
  return Object.keys(stamps).length > 0
    ? { ...rest, [HOLDER_NAME_CLEARED_KEY]: stamps }
    : rest;
}

/** Bank numbers support unbanned for this one account (owner, 2026-11-04):
 *  each stays banned for every other account, so a lifted ring number cannot
 *  come back to the ring. Keyed by payoutAccountKey; holds full numbers like
 *  the saved list, so it is fenced and stripped like it. Only support writes it
 *  (setPayoutBanLifted). */
export const PAYOUT_BAN_LIFTED_KEY = 'payout_ban_lifted';

export type LiftedPayoutBan = { bank_code: string; at: string };

export function liftedPayoutBans(
  metadata: Record<string, unknown>,
): Record<string, LiftedPayoutBan> {
  const stamps = metadata[PAYOUT_BAN_LIFTED_KEY];
  const out = Object.create(null) as Record<string, LiftedPayoutBan>;
  if (typeof stamps !== 'object' || stamps === null) return out;
  return Object.assign(
    out,
    Object.fromEntries(
      Object.entries(stamps).filter(
        ([, v]) =>
          typeof v === 'object' &&
          v !== null &&
          typeof (v as LiftedPayoutBan).at === 'string',
      ),
    ),
  );
}

/** The blob with one number's lift set, or removed by a null. */
export function withLiftedPayoutBan(
  metadata: Record<string, unknown>,
  key: string,
  stamp: LiftedPayoutBan | null,
): Record<string, unknown> {
  const { [key]: _old, ...others } = liftedPayoutBans(metadata);
  const stamps = stamp === null ? others : { ...others, [key]: stamp };
  const { [PAYOUT_BAN_LIFTED_KEY]: _key, ...rest } = metadata;
  return Object.keys(stamps).length > 0
    ? { ...rest, [PAYOUT_BAN_LIFTED_KEY]: stamps }
    : rest;
}

/** The blob with one account's stamp set, or cleared by a null. */
export function withBankShareStamp(
  metadata: Record<string, unknown>,
  accountId: string,
  stamp: string | null,
): Record<string, unknown> {
  const { [accountId]: _old, ...others } = verifiedBankAccounts(metadata);
  const stamps = stamp === null ? others : { ...others, [accountId]: stamp };
  const { [BANK_SHARE_VERIFIED_KEY]: _key, ...rest } = metadata;
  return Object.keys(stamps).length > 0
    ? { ...rest, [BANK_SHARE_VERIFIED_KEY]: stamps }
    : rest;
}

/** Has this other customer got the same destination verified? One person, one
 *  account: only one account per number can be. Digits only for a bank, as the
 *  holder lookup compares them; a wallet address is compared whole. */
export function verifiedElsewhere(
  metadata: Record<string, unknown>,
  account: SavedBankAccount,
): boolean {
  const key = (a: SavedBankAccount) =>
    findBank(a.bankCode)?.wallet
      ? a.accountNumber
      : accountNumberForms(a.bankCode, a.accountNumber)[0]
          .replace(/\D/g, '')
          .replace(/^0+/, '');
  const stamps = verifiedBankAccounts(metadata);
  return parseSavedBankAccounts(metadata.bank_accounts).some(
    (a) =>
      Boolean(stamps[a.id]) &&
      findBank(a.bankCode)?.id === findBank(account.bankCode)?.id &&
      key(a) === key(account),
  );
}

/** A new entry for a saved list, from details withdrawalDetailsError passed. */
export function newSavedBankAccount(
  bank: Bank,
  accountNumber: string,
  holderName: string,
): SavedBankAccount {
  // An EVM address is the same wallet in any letter case (the case is only its
  // checksum, already checked), so it is stored in one case: otherwise the
  // checksummed and lowercase copies save as two accounts.
  const number =
    bank.wallet === 'evm' ? accountNumber.toLowerCase() : accountNumber;
  return {
    id: savedBankAccountId(bank.id, number),
    bankCode: bank.id,
    bankName: bank.name,
    accountNumber: number,
    // A wallet has no holder (withdrawalDetailsError skips it); its network
    // name stands in, so the saved list and the admin queue still read.
    accountHolderName: bank.wallet ? bank.name : holderName.trim(),
    savedAt: new Date().toISOString(),
  };
}
