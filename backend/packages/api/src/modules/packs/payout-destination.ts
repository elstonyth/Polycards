import type { LedgerSqlManager } from './claim';
import { findBank } from './banks';
import {
  LETTER_FOLDS,
  SMALL_CAPS,
  SMALL_CAP_LETTERS,
  clearedHolderNames,
  holderNameKey,
  holderUnlikeSaved,
  liftedPayoutBans,
  parseSavedBankAccounts,
  payoutAccountKey,
  savedSlotFull,
  verifiedBankAccounts,
  type SavedBankAccount,
} from './saved-accounts';
import { realNameKey, realNameKeySql } from '../../utils/real-name';

// Payout Destination identity (ADR 0015: one Payout Destination per account).
// The one answer to "is this number banned for this player, who else holds it
// at this bank, is this holder name linked to another account": every
// spelling, the bank scope, exact wallet matching, payout statuses, cut rows,
// lifts and name clearings live here. Messages, writes, the cooling-off window,
// permissions and visitor signals (ADR 0016: a review clue, never a gate) stay
// with the callers. Reads only, on the manager the caller hands in, so a
// locked write stays on its own connection (mutateCustomerMetadata).

export type PayoutNumber = { bankCode: string | null; accountNumber: string };

/** Another live account on this number at this bank, once each. `paid`: a
 *  payout to it went out or is on its way. `verified`: support verified that
 *  account on this number (one person, one account). */
export type Holder = { customerId: string; paid: boolean; verified: boolean };

export type NumberStanding = {
  /** The canonical bank id; null for an unknown bank, whose holders are not
   *  checked. */
  bankId: string | null;
  /** payoutAccountKey of the canonical spelling. */
  key: string;
  forms: string[];
  /** On the ban list, for anyone. */
  banned: boolean;
  /** On the ban list under a spelling not lifted for this player. */
  bannedForPlayer: boolean;
  holders: Holder[];
};

/** `holders`: the other accounts that saved or were paid under this name.
 *  `blocking`: those support has not cleared for this player. */
export type NameStanding = { holders: string[]; blocking: string[] };

export type SaveBlock =
  | 'banned'
  | 'name_linked'
  | 'slot_full'
  | 'name_unlike_saved'
  | 'shared';

/** Every spelling of one destination, the canonical one first: a Singapore
 *  PayNow mobile with or without its 65 is one number. Saved rows keep what was
 *  typed and old rows hold either, so the holder and ban lookups, which match
 *  digits exactly, ask for each. The only place a number's spellings are made. */
export function spellings(
  bankCode: string | null,
  accountNumber: string,
): string[] {
  if (findBank(bankCode)?.id !== 'PAYNOWSG') return [accountNumber];
  // Digits as the keys read them, so '65 9123-4567' is the same number.
  const local = accountNumber
    .replace(/\D/g, '')
    .replace(/^0+/, '')
    .replace(/^65(?=\d{8}$)/, '');
  return /^\d{8}$/.test(local) ? [local, `65${local}`] : [accountNumber];
}

// holderNameKey in SQL, for holder names already stored: NFKD, the small
// capitals and LETTER_FOLDS folded, lower case, a-z only (the combining marks
// go with that strip). The parity spec runs it against holderNameKey.
const HOLDER_FOLDS = Object.entries(LETTER_FOLDS);
const HOLDER_FOLD_ONE = HOLDER_FOLDS.filter(([, to]) => to.length === 1);
const HOLDER_FOLD_FROM = `${SMALL_CAPS}${HOLDER_FOLD_ONE.map(([c]) => c).join('')}`;
const HOLDER_FOLD_TO = `${SMALL_CAP_LETTERS}${HOLDER_FOLD_ONE.map(([, to]) => to).join('')}`;
const HOLDER_FOLD_MANY = HOLDER_FOLDS.filter(([, to]) => to.length > 1);
export const holderNameKeySql = (expr: string): string => {
  const folded = HOLDER_FOLD_MANY.reduce(
    (sql, [c, to]) => `replace(${sql}, '${c}', '${to}')`,
    `translate(normalize(${expr}, NFKD), '${HOLDER_FOLD_FROM}', '${HOLDER_FOLD_TO}')`,
  );
  // ASCII has nothing to fold (one byte a character): skipping the folds
  // keeps the scan as cheap as before.
  return `regexp_replace(lower(CASE WHEN octet_length(${expr}) = length(${expr}) THEN ${expr} ELSE ${folded} END), '[^a-z]', '', 'g')`;
};

// Other customers tied to one spelling: saved on a live account, or a payout
// to it that went out or is on its way (failed rows came back and prove
// nothing). A deleted account frees its numbers: the deletion scrub cuts its
// payout rows to the last 4 digits, which the length check keeps from matching
// a short zero-padded number, and its saved list is not read. Bank codes come
// back raw (saved lists may still hold a retired gateway's alias); the caller
// compares canonical ids. holder_name is NULL for a payout row. Digits only,
// without leading zeros, on both sides: padding with a 0, or an older entry
// with spaces or dashes, does not slip past. A wallet address is compared
// whole instead: its digits alone collide across unrelated Tron addresses.
const HOLDERS_EXACT_SQL =
  "SELECT c.id AS customer_id, a->>'bankCode' AS bank_code, a->>'accountHolderName' AS holder_name " +
  'FROM customer c ' +
  "CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.metadata->'bank_accounts') = 'array' " +
  "  THEN c.metadata->'bank_accounts' ELSE '[]'::jsonb END) a " +
  "WHERE c.deleted_at IS NULL AND c.id <> ? AND a->>'accountNumber' = ? " +
  'UNION ' +
  'SELECT customer_id, bank_code, NULL AS holder_name FROM gateway_withdrawal ' +
  'WHERE deleted_at IS NULL AND customer_id <> ? AND account_number = ? ' +
  "AND status IN ('pending', 'held', 'settled')";
const HOLDERS_DIGITS_SQL =
  "SELECT c.id AS customer_id, a->>'bankCode' AS bank_code, a->>'accountHolderName' AS holder_name " +
  'FROM customer c ' +
  "CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.metadata->'bank_accounts') = 'array' " +
  "  THEN c.metadata->'bank_accounts' ELSE '[]'::jsonb END) a " +
  "WHERE c.deleted_at IS NULL AND c.id <> ? AND ltrim(regexp_replace(a->>'accountNumber', '[^0-9]', '', 'g'), '0') = ltrim(regexp_replace(?, '[^0-9]', '', 'g'), '0') " +
  'UNION ' +
  'SELECT customer_id, bank_code, NULL AS holder_name FROM gateway_withdrawal ' +
  "WHERE deleted_at IS NULL AND customer_id <> ? AND ltrim(regexp_replace(account_number, '[^0-9]', '', 'g'), '0') = ltrim(regexp_replace(?, '[^0-9]', '', 'g'), '0') " +
  "AND length(regexp_replace(account_number, '[^0-9]', '', 'g')) > 4 " +
  "AND status IN ('pending', 'held', 'settled')";

/** The number as one destination compares: digits of the canonical spelling
 *  without leading zeros, a wallet address whole. */
const destinationKey = (bankCode: string, accountNumber: string): string =>
  findBank(bankCode)?.wallet
    ? accountNumber
    : payoutAccountKey(spellings(bankCode, accountNumber)[0], false);

/** Is this number banned (for anyone, and for this player), and who else holds
 *  it at this bank? Banned: any spelling's key is on banned_payout_account, at
 *  any bank, however it is padded; for this player, unless support lifted that
 *  same key for them (setPayoutBanLifted). Holders: every spelling, at this
 *  bank only (the same digits at another bank are someone else's account); a
 *  wallet address compared whole. A caller that lists or frees bank numbers
 *  only checks bank.wallet itself. A deleted account's lifts count for no one. */
export async function numberStanding(
  em: LedgerSqlManager,
  customerId: string,
  n: PayoutNumber,
): Promise<NumberStanding> {
  const bank = findBank(n.bankCode);
  // The chain, not just "a wallet": an EVM address keys lower case, as it is
  // stored (newSavedBankAccount) and banned.
  const wallet = bank?.wallet ?? false;
  const forms = spellings(n.bankCode, n.accountNumber);
  const keys = [...new Set(forms.map((f) => payoutAccountKey(f, wallet)))];
  const bannedKeys = (
    await em.execute<{ account_key: string }[]>(
      "SELECT account_key FROM banned_payout_account WHERE account_key = ANY(string_to_array(?, ','))",
      [keys.join(',')],
    )
  ).map((r) => r.account_key);
  let bannedForPlayer = false;
  if (bannedKeys.length > 0) {
    const [me] = await em.execute<
      { metadata: Record<string, unknown> | null }[]
    >('SELECT metadata FROM customer WHERE id = ? AND deleted_at IS NULL', [
      customerId,
    ]);
    const lifted = liftedPayoutBans(me?.metadata ?? {});
    bannedForPlayer = bannedKeys.some((k) => !lifted[k]);
  }
  const holders: Holder[] = [];
  if (bank) {
    const paid = new Map<string, boolean>();
    for (const form of forms) {
      const rows = await em.execute<
        { customer_id: string; bank_code: string; holder_name: string | null }[]
      >(wallet ? HOLDERS_EXACT_SQL : HOLDERS_DIGITS_SQL, [
        customerId,
        form,
        customerId,
        form,
      ]);
      for (const r of rows) {
        if (findBank(r.bank_code)?.id !== bank.id) continue;
        paid.set(
          r.customer_id,
          (paid.get(r.customer_id) ?? false) || r.holder_name == null,
        );
      }
    }
    // One person, one account: which of them support verified on this
    // number, read only when someone holds it.
    const verified = new Set<string>();
    if (paid.size > 0) {
      const mine = destinationKey(bank.id, n.accountNumber);
      for (const c of await em.execute<
        { id: string; metadata: Record<string, unknown> | null }[]
      >(
        "SELECT id, metadata FROM customer WHERE id = ANY(string_to_array(?, ',')) AND deleted_at IS NULL",
        [[...paid.keys()].join(',')],
      )) {
        const stamps = verifiedBankAccounts(c.metadata ?? {});
        if (
          parseSavedBankAccounts(c.metadata?.bank_accounts).some(
            (a) =>
              Boolean(stamps[a.id]) &&
              findBank(a.bankCode)?.id === bank.id &&
              destinationKey(a.bankCode, a.accountNumber) === mine,
          )
        ) {
          verified.add(c.id);
        }
      }
    }
    for (const [customerId, isPaid] of paid) {
      holders.push({
        customerId,
        paid: isPaid,
        verified: verified.has(customerId),
      });
    }
  }
  return {
    bankId: bank?.id ?? null,
    key: payoutAccountKey(forms[0], wallet),
    forms,
    banned: bannedKeys.length > 0,
    bannedForPlayer,
    holders,
  };
}

/** Who else saved or was paid under this holder name (owner, 2026-11-03: a
 *  different bank under the same name is refused too), and which of them
 *  still block this player. Names compare by holderNameKey, the stored ones in
 *  SQL (holderNameKeySql), so a variant saved with accents or symbols still
 *  finds the plain name. A wallet entry carries its network's name, which no
 *  person's name equals. Never truncated: a clearing must see every holder.
 *  The accounts support cleared as another person with this name
 *  (setHolderNameCleared) do not block, for this player only. */
export async function nameStanding(
  em: LedgerSqlManager,
  customerId: string,
  holderName: string,
): Promise<NameStanding> {
  // A name with no English letter (saved before such names were refused)
  // keys empty by its letters; it is compared by its old key instead, so
  // its holders are still found. Empty both ways names no one.
  const letters = holderNameKey(holderName);
  const key = letters || realNameKey(holderName);
  if (!key) return { holders: [], blocking: [] };
  const keySql = letters ? holderNameKeySql : realNameKeySql;
  const holders = (
    await em.execute<{ customer_id: string }[]>(
      'SELECT c.id AS customer_id FROM customer c ' +
        "CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.metadata->'bank_accounts') = 'array' " +
        "  THEN c.metadata->'bank_accounts' ELSE '[]'::jsonb END) a " +
        `WHERE c.deleted_at IS NULL AND c.id <> ? AND ${keySql("a->>'accountHolderName'")} = ? ` +
        'UNION ' +
        'SELECT customer_id FROM gateway_withdrawal WHERE deleted_at IS NULL AND customer_id <> ? ' +
        `AND ${keySql('account_holder_name')} = ? ` +
        "AND status IN ('pending', 'held', 'settled')",
      [customerId, key, customerId, key],
    )
  ).map((r) => r.customer_id);
  if (holders.length === 0) return { holders, blocking: [] };
  const [me] = await em.execute<{ metadata: Record<string, unknown> | null }[]>(
    'SELECT metadata FROM customer WHERE id = ? AND deleted_at IS NULL',
    [customerId],
  );
  const cleared =
    clearedHolderNames(me?.metadata ?? {})[holderNameKey(holderName)]?.with ??
    [];
  return { holders, blocking: holders.filter((id) => !cleared.includes(id)) };
}

/** Does someone else holding this number refuse a new save of it? Any holder
 *  of a bank number, under any name. A wallet's address is public on-chain and
 *  has no holder name, so a stranger who merely saved it must not stop its
 *  owner saving it: only one someone was already PAID to blocks. The payout
 *  check still sees the saved entry (holdsPayout). */
const blocksSave = (s: NumberStanding): boolean => {
  const wallet = findBank(s.bankId)?.wallet;
  return s.holders.some((h) => !wallet || h.paid);
};

/** The blocks on a customer save, in the save's order: banned, name linked,
 *  then (unless the account is already saved, a no-op that succeeds) the slot,
 *  one name on every bank, and a number someone else holds. */
export function saveVerdict(a: {
  number: NumberStanding;
  name: NameStanding | null;
  saved: SavedBankAccount[];
  accountId: string;
  holderName: string;
}): { alreadySaved: boolean; blocks: SaveBlock[] } {
  const blocks: SaveBlock[] = [];
  if (a.number.bannedForPlayer) blocks.push('banned');
  if (a.name && a.name.blocking.length > 0) blocks.push('name_linked');
  const alreadySaved = a.saved.some((s) => s.id === a.accountId);
  if (alreadySaved) return { alreadySaved, blocks };
  if (a.number.bankId !== null) {
    if (savedSlotFull(a.saved, a.number.bankId)) blocks.push('slot_full');
    if (holderUnlikeSaved(a.saved, a.number.bankId, a.holderName)) {
      blocks.push('name_unlike_saved');
    }
  }
  if (blocksSave(a.number)) blocks.push('shared');
  return { alreadySaved, blocks };
}

/** Does a payout to this number wait for support? Any other holder holds it,
 *  a wallet someone only saved included, unless support verified this player
 *  on it. */
export function holdsPayout(s: NumberStanding, verifiedHere: boolean): boolean {
  return !verifiedHere && s.holders.length > 0;
}

/** Is any saved account support has not verified held by someone else? The
 *  whole list counts, not only the one being paid: a second saved number must
 *  not be the way round a hold. Lists hold a handful of rows, so one lookup
 *  each is fine. */
export async function savedListHeld(
  standingOf: (n: PayoutNumber) => Promise<NumberStanding>,
  accounts: SavedBankAccount[],
  verified: Record<string, string>,
): Promise<boolean> {
  const verdicts = await Promise.all(
    accounts
      .filter((a) => !verified[a.id])
      .map(async (a) =>
        holdsPayout(
          await standingOf({
            bankCode: a.bankCode,
            accountNumber: a.accountNumber,
          }),
          false,
        ),
      ),
  );
  return verdicts.some(Boolean);
}
