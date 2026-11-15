import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { findBank } from '../../../../modules/packs/banks';
import { spellings } from '../../../../modules/packs/payout-destination';
import {
  clearedHolderNames,
  liftedPayoutBans,
  payoutAccountKey,
} from '../../../../modules/packs/saved-accounts';
import { PERMANENT_BAN_REASON_PREFIX } from '../../../utils/disabled-guard';
import { realNameKeySql } from '../../../../utils/real-name';
import { findReportPlayer } from '../../player-lookup';
import { reportDb, type ReportDb } from '../../sql';
import { nameGroups } from './name-groups';

// GET /reports/support/ban: why accounts are banned and who is linked with whom,
// for support and the admin assistant (owner, 2026-11-03). Look up by whatever
// staff have, exactly one of:
//   ?username=     shown name or profile handle: that player's ban and every
//                  bank they saved or were paid to, with the other accounts on it
//   ?email= / ?phone=   the same, found by the account's email or phone
//   ?bank_account= every account that saved or was paid to that number
//   ?holder_name=  every account that saved or was paid under that holder name
// Banks show as bank name and last 4 digits only. Holder names are compared,
// never shown: accounts that used the same one share a holder_name_group. A
// staff-typed disable reason stays private. No email, phone, customer id or full
// account number in any answer.

const PERMANENT_BAN_TEXT =
  'Permanent ban: the same bank account was used on more than one Polycards account (one person, one account).';

const LOOKUPS = [
  'username',
  'email',
  'phone',
  'bank_account',
  'holder_name',
] as const;

const SAVED = `jsonb_array_elements(CASE WHEN jsonb_typeof(c.metadata->'bank_accounts') = 'array' THEN c.metadata->'bank_accounts' ELSE '[]'::jsonb END) a`;
const DIGITS = (col: string) =>
  `ltrim(regexp_replace(${col}, '[^0-9]', '', 'g'), '0')`;
const NAME = (col: string) => `NULLIF(${realNameKeySql(col)}, '')`;
const LIVE_PAYOUT = `deleted_at IS NULL AND status IN ('pending', 'held', 'settled')`;
const ANY_FORM = (col: string) =>
  `${DIGITS(col)} = ANY(string_to_array(?, ','))`;

type NumberRow = { bank_code: string; account_number: string };
type AccountRow = {
  customer_id: string;
  username: string | null;
  handle: string | null;
  deleted: boolean;
  disabled: boolean | null;
  reason: string | null;
  keys: string[] | null;
};
/** A stored row's bank and digits, as `sameNumber` reads them. */
type AtNumber = { bank_code: string; digits: string };

const banState = (disabled: boolean | null, reason: string | null) => ({
  banned:
    disabled === true && (reason ?? '').startsWith(PERMANENT_BAN_REASON_PREFIX),
  disabled: disabled === true,
});

const bankId = (code: string | null) => findBank(code)?.id ?? '';

/** A stored number as the save and withdrawal checks compare it: its bank, and
 *  its first spelling (a PayNow mobile without its 65) as the key. */
function numberAtBank(bankCode: string, accountNumber: string) {
  const forms = spellings(
    bankCode,
    payoutAccountKey(accountNumber, false),
  );
  const bank = bankId(bankCode);
  return { bank, key: forms[0], forms, id: `${bank}:${forms[0]}` };
}

/** Is a stored row the number `key`, as the save and withdrawal checks read
 *  it: under any spelling, and at `bank` when one is given (heldByAnother: the
 *  same digits at another bank are someone else's account). */
const sameNumber =
  (key: string, bank?: string) =>
  (row: AtNumber): boolean =>
    (bank === undefined || bankId(row.bank_code) === bank) &&
    spellings(row.bank_code, row.digits).includes(key);

/** Settled payouts per customer to one number. */
async function payoutsTo(
  db: ReportDb,
  forms: string[],
  match: (row: AtNumber) => boolean,
) {
  const rows = (
    await db.raw<AtNumber & { customer_id: string; n: number; rm: string }>(
      `SELECT customer_id, bank_code, ${DIGITS('account_number')} AS digits,
              count(*)::int AS n, coalesce(sum(amount), 0)::text AS rm FROM gateway_withdrawal
        WHERE deleted_at IS NULL AND status = 'settled' AND ${ANY_FORM('account_number')}
        GROUP BY 1, 2, 3`,
      [forms.join(',')],
    )
  ).rows.filter(match);
  return (customerId: string) => {
    const mine = rows.filter((r) => r.customer_id === customerId);
    return {
      count: mine.reduce((n, r) => n + r.n, 0),
      rm: Number(mine.reduce((rm, r) => rm + Number(r.rm), 0).toFixed(2)),
    };
  };
}

/** Is a number banned, as payoutAccountBanned reads it: any of its spellings
 *  on the list (at any bank), and for a player, not one support lifted for
 *  them (setPayoutBanLifted keys the lift by the listed spelling). */
async function banOf(
  db: ReportDb,
  forms: string[],
  metadata?: Record<string, unknown> | null,
) {
  const listed = (
    await db.raw<{ account_key: string }>(
      "SELECT account_key FROM banned_payout_account WHERE account_key = ANY(string_to_array(?, ','))",
      [forms.join(',')],
    )
  ).rows;
  const lifted = liftedPayoutBans(metadata ?? {});
  return {
    banned: listed.some((b) => !lifted[b.account_key]),
    lifted: listed.length > 0 && listed.every((b) => lifted[b.account_key]),
  };
}

/** Every live account on one number (saved, or a payout that went out or is
 *  on its way), with the holder-name keys each used on it and its banks. */
async function accountsOn(
  db: ReportDb,
  forms: string[],
  match: (row: AtNumber) => boolean,
): Promise<(AccountRow & { keys: string[]; banks: string[] })[]> {
  const rows = (
    await db.raw<Omit<AccountRow, 'keys'> & AtNumber & { k: string | null }>(
      `WITH h AS (
         SELECT c.id AS customer_id, a->>'bankCode' AS bank_code, ${DIGITS("a->>'accountNumber'")} AS digits,
                ${NAME("a->>'accountHolderName'")} AS k
           FROM customer c CROSS JOIN LATERAL ${SAVED}
          WHERE c.deleted_at IS NULL AND ${ANY_FORM("a->>'accountNumber'")}
         UNION SELECT customer_id, bank_code, ${DIGITS('account_number')}, ${NAME('account_holder_name')} FROM gateway_withdrawal
          WHERE ${LIVE_PAYOUT} AND ${ANY_FORM('account_number')}
       )
       SELECT h.customer_id, h.bank_code, h.digits, h.k, c.first_name AS username,
              c.metadata->>'handle' AS handle, c.deleted_at IS NOT NULL AS deleted,
              s.disabled, s.disabled_reason AS reason
         FROM h JOIN customer c ON c.id = h.customer_id
         LEFT JOIN customer_account_state s ON s.customer_id = h.customer_id AND s.deleted_at IS NULL
        ORDER BY c.first_name, h.customer_id`,
      [forms.join(','), forms.join(',')],
    )
  ).rows.filter(match);
  const byCustomer = new Map<
    string,
    { row: (typeof rows)[number]; keys: Set<string>; banks: Set<string> }
  >();
  for (const r of rows) {
    const entry = byCustomer.get(r.customer_id) ?? {
      row: r,
      keys: new Set<string>(),
      banks: new Set<string>(),
    };
    if (r.k) entry.keys.add(r.k);
    if (r.bank_code) entry.banks.add(r.bank_code);
    byCustomer.set(r.customer_id, entry);
  }
  return [...byCustomer.values()].map(({ row, keys, banks }) => ({
    customer_id: row.customer_id,
    username: row.username,
    handle: row.handle,
    deleted: row.deleted,
    disabled: row.disabled,
    reason: row.reason,
    keys: [...keys].sort(),
    banks: [...banks],
  }));
}

/** One player's ban and every bank they saved or were paid to. */
async function playerView(db: ReportDb, id: string, lookupNote?: string) {
  const [state] = (
    await db.raw<{
      disabled: boolean | null;
      disabled_reason: string | null;
      disabled_at: string | null;
    }>(
      'SELECT disabled, disabled_reason, disabled_at FROM customer_account_state WHERE customer_id = ? AND deleted_at IS NULL',
      [id],
    )
  ).rows;
  const [who] = (
    await db.raw<{
      username: string | null;
      handle: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      "SELECT first_name AS username, metadata->>'handle' AS handle, metadata FROM customer WHERE id = ?",
      [id],
    )
  ).rows;
  const disabled = state?.disabled === true;
  const permanent =
    disabled &&
    (state?.disabled_reason ?? '').startsWith(PERMANENT_BAN_REASON_PREFIX);

  const numbers = (
    await db.raw<NumberRow>(
      `SELECT a->>'bankCode' AS bank_code, a->>'accountNumber' AS account_number FROM customer c CROSS JOIN LATERAL ${SAVED} WHERE c.id = ?
       UNION SELECT bank_code, account_number FROM gateway_withdrawal WHERE ${LIVE_PAYOUT} AND customer_id = ?
       ORDER BY 1, 2`,
      [id, id],
    )
  ).rows;
  // One entry per number, as the save and withdrawal checks match it: digits
  // without leading zeros under every spelling (a PayNow mobile with or without
  // its 65), at its own bank. A wallet has no holder to share.
  const byKey = new Map<
    string,
    { row: NumberRow; at: ReturnType<typeof numberAtBank> }
  >();
  for (const row of numbers) {
    // An entry from before the saved-list shape has no number to compare.
    if (!row.account_number || findBank(row.bank_code)?.wallet) continue;
    const at = numberAtBank(row.bank_code, row.account_number);
    if (at.key.length > 4 && !byKey.has(at.id)) byKey.set(at.id, { row, at });
  }

  const linked = new Set<string>();
  const myNames = new Set<string>();
  const banks: Record<string, unknown>[] = [];
  for (const { row, at } of byKey.values()) {
    const match = sameNumber(at.key, at.bank);
    const accounts = await accountsOn(db, at.forms, match);
    const mine = new Set(
      accounts.find((a) => a.customer_id === id)?.keys ?? [],
    );
    for (const k of mine) myNames.add(k);
    const payouts = await payoutsTo(db, at.forms, match);
    const others = accounts.filter((a) => a.customer_id !== id);
    for (const o of others) linked.add(o.customer_id);
    const ban = await banOf(db, at.forms, who?.metadata);
    banks.push({
      bank: findBank(row.bank_code)?.name ?? row.bank_code,
      last4: at.key.slice(-4),
      banned_number: ban.banned,
      lifted_for_player: ban.lifted,
      this_player_payouts: payouts(id),
      other_accounts: others.map((o) => ({
        username: o.username,
        handle: o.handle,
        ...banState(o.disabled, o.reason),
        // Its payouts still count; the name and handle went with the deletion.
        deleted: o.deleted === true,
        // null when either side has no name on file to compare.
        same_holder_name:
          mine.size === 0 || (o.keys ?? []).length === 0
            ? null
            : (o.keys ?? []).some((k) => mine.has(k)),
        payouts: payouts(o.customer_id),
      })),
    });
  }

  // Accounts under one of this player's holder names at a DIFFERENT bank
  // number: linked by the name, not the number.
  const sameName = myNames.size
    ? (
        await db.raw<
          AccountRow & { bank_code: string; account_number: string }
        >(
          `WITH h AS (
             SELECT c.id AS customer_id, a->>'bankCode' AS bank_code, a->>'accountNumber' AS account_number
               FROM customer c CROSS JOIN LATERAL ${SAVED}
              WHERE c.deleted_at IS NULL AND c.id <> ? AND ${NAME("a->>'accountHolderName'")} = ANY(string_to_array(?, ','))
             UNION SELECT customer_id, bank_code, account_number FROM gateway_withdrawal
              WHERE ${LIVE_PAYOUT} AND customer_id <> ? AND ${NAME('account_holder_name')} = ANY(string_to_array(?, ','))
           )
           SELECT h.customer_id, h.bank_code, h.account_number, c.first_name AS username,
                  c.metadata->>'handle' AS handle, c.deleted_at IS NOT NULL AS deleted,
                  s.disabled, s.disabled_reason AS reason
             FROM h JOIN customer c ON c.id = h.customer_id
             LEFT JOIN customer_account_state s ON s.customer_id = h.customer_id AND s.deleted_at IS NULL
            ORDER BY c.first_name`,
          [id, [...myNames].join(','), id, [...myNames].join(',')],
        )
      ).rows.filter((r) => !linked.has(r.customer_id))
    : [];
  // Pairs support checked as two people with one name (bank-accounts/
  // name-clash), from either side: not one person, so not linked.
  const twinIds = [...new Set(sameName.map((r) => r.customer_id))];
  const stamps = twinIds.length
    ? (
        await db.raw<{ id: string; metadata: Record<string, unknown> | null }>(
          "SELECT id, metadata FROM customer WHERE id = ANY(string_to_array(?, ','))",
          [[id, ...twinIds].join(',')],
        )
      ).rows
    : [];
  const checkedWith = (of: string) =>
    Object.values(
      clearedHolderNames(stamps.find((s) => s.id === of)?.metadata ?? {}),
    ).flatMap((c) => c.with);
  const clearedPair = (twin: string) =>
    checkedWith(id).includes(twin) || checkedWith(twin).includes(id);
  const sameNameAccounts = new Map<
    string,
    { row: AccountRow; banks: Map<string, string> }
  >();
  for (const r of sameName) {
    if (!r.account_number || findBank(r.bank_code)?.wallet) continue;
    const at = numberAtBank(r.bank_code, r.account_number);
    const entry = sameNameAccounts.get(r.customer_id) ?? {
      row: r,
      banks: new Map<string, string>(),
    };
    if (at.key.length > 4) {
      entry.banks.set(at.id, findBank(r.bank_code)?.name ?? r.bank_code);
    }
    sameNameAccounts.set(r.customer_id, entry);
  }
  for (const customerId of sameNameAccounts.keys()) {
    if (!clearedPair(customerId)) linked.add(customerId);
  }

  return {
    username: who?.username ?? null,
    handle: who?.handle ?? null,
    disabled,
    permanent_ban: permanent,
    // Fixed text, never the stored one: staff-typed text stays out.
    reason: permanent
      ? PERMANENT_BAN_TEXT
      : disabled
        ? 'Disabled by staff (the reason is on the admin player page).'
        : null,
    disabled_at: disabled ? state?.disabled_at : null,
    linked_accounts_total: linked.size,
    bank_accounts: banks,
    same_name_accounts: [...sameNameAccounts.values()].map(
      ({ row, banks: theirs }) => ({
        username: row.username,
        handle: row.handle,
        ...banState(row.disabled, row.reason),
        deleted: row.deleted === true,
        cleared_as_different_person: clearedPair(row.customer_id),
        banks: [...theirs].map(([key, bank]) => ({
          bank,
          last4: key.slice(-4),
        })),
      }),
    ),
    ...(lookupNote ? { lookup_note: lookupNote } : {}),
    note: "A permanent ban (owner, 2026-11-03) is for one person with more than one account: the same bank account, or the same account holder name, on more than one Polycards account. bank_accounts are every bank this player saved or was paid to, by bank name and last 4 digits (a PayNow mobile with or without its 65 is one number); banned_number is whether the number is banned for this player, as their bank save and withdrawal read it: lifted_for_player true means it is on the ban list but support unbanned it for this player only. other_accounts are the other accounts on that same number at that same bank (the same digits at another bank are someone else's account), with their settled payouts to it (RM). same_name_accounts used one of this player's holder names at a different bank; cleared_as_different_person true means support checked them as two different people with one name: not one person, not counted in linked_accounts_total, and no reason to ban. linked_accounts_total counts every linked account once, this player not included: the person holds linked_accounts_total + 1 accounts. It counts bank and holder-name links only: 0 is not proof the accounts are unrelated, and account_links checks browser, network, delivery address and real name. same_holder_name: true same name, false a different name, null no name to compare. banned = permanent ban; disabled = cannot log in (a ban, or staff); deleted = the account was deleted (its name and handle are gone, its payouts still count). disabled_at is UTC: say it in Malaysia time. Lifting the ban clears the saved banks and any name clearing; the player links a bank again. A banned number stays banned after an account unban: it is unbanned for one player with unban_bank_number. Why a player's own bank save is refused, and what fixes it: bank_save_check.",
  };
}

/** Every account on one bank number. Staff give no bank, so the number is
 *  looked up under every spelling a PayNow save would ask: the other spelling
 *  (with or without 65) matches PayNow rows only, any other bank needs the same
 *  digits. Banned as a save of it at a bank it is at would read it (the list
 *  is at any bank), with no player's lift: a 65 number at CIMB is not asked
 *  without its 65. */
async function numberView(db: ReportDb, key: string) {
  const forms = spellings('PAYNOWSG', key);
  const match = sameNumber(key);
  const accounts = await accountsOn(db, forms, match);
  const payouts = await payoutsTo(db, forms, match);
  const groups = nameGroups(accounts);
  const banForms = [
    ...new Set([
      key,
      ...accounts.flatMap((a) =>
        a.banks.flatMap((b) => spellings(b, key)),
      ),
    ]),
  ];
  return {
    bank_account: {
      // Every bank the number is at.
      banks: [
        ...new Set(
          accounts.flatMap((a) => a.banks.map((b) => findBank(b)?.name ?? b)),
        ),
      ].sort(),
      last4: key.slice(-4),
      banned_number: (await banOf(db, banForms)).banned,
    },
    account_count: accounts.length,
    accounts: accounts.map((a) => ({
      username: a.username,
      handle: a.handle,
      ...banState(a.disabled, a.reason),
      deleted: a.deleted === true,
      holder_name_group: groups.get(a.customer_id) ?? null,
      payouts: payouts(a.customer_id),
    })),
    note: 'Every account that saved this bank account or was paid to it (pending, held or settled), at any bank in banks, with its settled payouts to it in RM. A PayNow mobile is found with or without its 65; at any other bank only the same digits match. banned_number is the ban list, before any unban for one player (the username lookup shows that). Accounts with the same holder_name_group used the same account holder name; null = no name on file. One number on more than one account breaks one person, one account.',
  };
}

/** Every account that saved or was paid under one holder name. */
async function nameView(db: ReportDb, name: string) {
  const rows = (
    await db.raw<AccountRow & { bank_code: string; account_number: string }>(
      `WITH h AS (
         SELECT c.id AS customer_id, a->>'bankCode' AS bank_code, a->>'accountNumber' AS account_number
           FROM customer c CROSS JOIN LATERAL ${SAVED}
          WHERE c.deleted_at IS NULL AND ${NAME("a->>'accountHolderName'")} = ${NAME('?::text')}
         UNION SELECT customer_id, bank_code, account_number FROM gateway_withdrawal
          WHERE ${LIVE_PAYOUT} AND ${NAME('account_holder_name')} = ${NAME('?::text')}
       )
       SELECT h.customer_id, h.bank_code, h.account_number, c.first_name AS username,
              c.metadata->>'handle' AS handle, c.deleted_at IS NOT NULL AS deleted,
              s.disabled, s.disabled_reason AS reason
         FROM h JOIN customer c ON c.id = h.customer_id
         LEFT JOIN customer_account_state s ON s.customer_id = h.customer_id AND s.deleted_at IS NULL
        ORDER BY c.first_name`,
      [name, name],
    )
  ).rows;
  const byCustomer = new Map<
    string,
    { row: AccountRow; banks: Map<string, string> }
  >();
  for (const r of rows) {
    if (!r.account_number || findBank(r.bank_code)?.wallet) continue;
    const at = numberAtBank(r.bank_code, r.account_number);
    if (at.key.length <= 4) continue;
    const entry = byCustomer.get(r.customer_id) ?? {
      row: r,
      banks: new Map<string, string>(),
    };
    entry.banks.set(at.id, findBank(r.bank_code)?.name ?? r.bank_code);
    byCustomer.set(r.customer_id, entry);
  }
  return {
    account_count: byCustomer.size,
    accounts: [...byCustomer.values()].map(({ row, banks }) => ({
      username: row.username,
      handle: row.handle,
      ...banState(row.disabled, row.reason),
      deleted: row.deleted === true,
      banks: [...banks].map(([key, bank]) => ({ bank, last4: key.slice(-4) })),
    })),
    note: 'Every account that saved a bank or was paid under this account holder name (case, spaces and dots ignored), with the banks it used under it by bank name and last 4 digits. More than one account under one name breaks one person, one account.',
  };
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const given = LOOKUPS.filter(
    (k) => typeof query[k] === 'string' && (query[k] as string).trim() !== '',
  );
  if (given.length !== 1) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Give exactly one of username, email, phone, bank_account or holder_name.',
    );
  }
  const by = given[0];
  const value = (query[by] as string).trim();
  const db = reportDb(req);

  if (by === 'bank_account') {
    const key = payoutAccountKey(value, false);
    if (key.length <= 4) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'bank_account must be the account number (more than 4 digits).',
      );
    }
    res.json(await numberView(db, key));
    return;
  }
  if (by === 'holder_name') {
    // Separators alone would key to nothing and match no one.
    if (
      value.length < 2 ||
      value.length > 120 ||
      value.replace(/[\s.'@/,-]/g, '') === ''
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'holder_name must be a name of 2-120 characters.',
      );
    }
    res.json(await nameView(db, value));
    return;
  }
  if (by === 'username') {
    const { id, lookupNote } = await findReportPlayer(req);
    res.json(await playerView(db, id, lookupNote));
    return;
  }

  // Email or phone: the account, or every account when an old phone sits on
  // several (before one phone, one account).
  const ids =
    by === 'email'
      ? (
          await db.raw<{ id: string }>(
            'SELECT id FROM customer WHERE deleted_at IS NULL AND has_account = true AND lower(email) = lower(?) ORDER BY created_at LIMIT 6',
            [value],
          )
        ).rows.map((r) => r.id)
      : await (async () => {
          const digits = value.replace(/\D/g, '');
          if (digits.length < 8) {
            throw new MedusaError(
              MedusaError.Types.INVALID_DATA,
              'phone must have at least 8 digits.',
            );
          }
          // Phones are stored with their country code (+60..., +65...): the
          // number exactly as typed, with 60 in place of a leading 0, or with 65.
          return (
            await db.raw<{ id: string }>(
              "SELECT id FROM customer WHERE deleted_at IS NULL AND has_account = true AND regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') IN (?, ?, ?) ORDER BY created_at LIMIT 6",
              [digits, `60${digits.replace(/^0/, '')}`, `65${digits}`],
            )
          ).rows.map((r) => r.id);
        })();
  if (ids.length === 0) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `No player with that ${by}.`,
    );
  }
  if (ids.length === 1) {
    res.json(await playerView(db, ids[0]));
    return;
  }
  res.json({
    // One at a time: each view runs several queries on a small pool.
    players: await (async () => {
      const views: Awaited<ReturnType<typeof playerView>>[] = [];
      for (const id of ids.slice(0, 5)) views.push(await playerView(db, id));
      return views;
    })(),
    note: `More than one account has this ${by}; each is listed with its own bank links.${ids.length > 5 ? ' Only the first 5 are shown: there are more.' : ''}`,
  });
}
