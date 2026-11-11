import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { findBank } from '../../../../modules/packs/banks';
import {
  clearedHolderNames,
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

const banState = (disabled: boolean | null, reason: string | null) => ({
  banned:
    disabled === true && (reason ?? '').startsWith(PERMANENT_BAN_REASON_PREFIX),
  disabled: disabled === true,
});

/** Settled payouts per customer to one number. */
async function payoutsTo(db: ReportDb, key: string) {
  const rows = (
    await db.raw<{ customer_id: string; n: number; rm: string }>(
      `SELECT customer_id, count(*)::int AS n, coalesce(sum(amount), 0)::text AS rm FROM gateway_withdrawal
        WHERE deleted_at IS NULL AND status = 'settled' AND ${DIGITS('account_number')} = ?
        GROUP BY customer_id`,
      [key],
    )
  ).rows;
  return (customerId: string) => {
    const p = rows.find((r) => r.customer_id === customerId);
    return { count: p?.n ?? 0, rm: Number(p?.rm ?? 0) };
  };
}

const isBanned = async (db: ReportDb, key: string) =>
  (
    await db.raw(
      'SELECT 1 FROM banned_payout_account WHERE account_key = ? LIMIT 1',
      [key],
    )
  ).rows.length > 0;

/** Every live account on one number (saved, or a payout that went out or is
 *  on its way), with the holder-name keys each used on it. */
async function accountsOn(db: ReportDb, key: string): Promise<AccountRow[]> {
  return (
    await db.raw<AccountRow>(
      `WITH h AS (
         SELECT c.id AS customer_id, ${NAME("a->>'accountHolderName'")} AS k FROM customer c CROSS JOIN LATERAL ${SAVED}
          WHERE c.deleted_at IS NULL AND ${DIGITS("a->>'accountNumber'")} = ?
         UNION SELECT customer_id, ${NAME('account_holder_name')} FROM gateway_withdrawal
          WHERE ${LIVE_PAYOUT} AND ${DIGITS('account_number')} = ?
       )
       SELECT h.customer_id, c.first_name AS username, c.metadata->>'handle' AS handle,
              c.deleted_at IS NOT NULL AS deleted, s.disabled, s.disabled_reason AS reason,
              array_agg(DISTINCT h.k) FILTER (WHERE h.k IS NOT NULL) AS keys
         FROM h JOIN customer c ON c.id = h.customer_id
         LEFT JOIN customer_account_state s ON s.customer_id = h.customer_id AND s.deleted_at IS NULL
        GROUP BY h.customer_id, c.id, s.id
        ORDER BY c.first_name`,
      [key, key],
    )
  ).rows;
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
    await db.raw<{ username: string | null; handle: string | null }>(
      "SELECT first_name AS username, metadata->>'handle' AS handle FROM customer WHERE id = ?",
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
  // One entry per number, as the ban and the holder lookup match them: digits
  // without leading zeros, at any bank. A wallet has no holder to share.
  const byKey = new Map<string, NumberRow>();
  for (const row of numbers) {
    // An entry from before the saved-list shape has no number to compare.
    if (!row.account_number || findBank(row.bank_code)?.wallet) continue;
    const key = payoutAccountKey(row.account_number, false);
    if (key.length > 4 && !byKey.has(key)) byKey.set(key, row);
  }

  const linked = new Set<string>();
  const myNames = new Set<string>();
  const banks: Record<string, unknown>[] = [];
  for (const [key, row] of byKey) {
    const accounts = await accountsOn(db, key);
    const mine = new Set(
      accounts.find((a) => a.customer_id === id)?.keys ?? [],
    );
    for (const k of mine) myNames.add(k);
    const payouts = await payoutsTo(db, key);
    const others = accounts.filter((a) => a.customer_id !== id);
    for (const o of others) linked.add(o.customer_id);
    banks.push({
      bank: findBank(row.bank_code)?.name ?? row.bank_code,
      last4: key.slice(-4),
      banned_number: await isBanned(db, key),
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
          'SELECT id, metadata FROM customer WHERE id = ANY(string_to_array(?, \',\'))',
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
    const key = payoutAccountKey(r.account_number, false);
    const entry = sameNameAccounts.get(r.customer_id) ?? {
      row: r,
      banks: new Map<string, string>(),
    };
    if (key.length > 4) {
      entry.banks.set(key, findBank(r.bank_code)?.name ?? r.bank_code);
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
    note: "A permanent ban (owner, 2026-11-03) is for one person with more than one account: the same bank account, or the same account holder name, on more than one Polycards account. bank_accounts are every bank this player saved or was paid to, by bank name and last 4 digits; other_accounts are the other accounts on that same number, with their settled payouts to it (RM). same_name_accounts used one of this player's holder names at a different bank; cleared_as_different_person true means support checked them as two different people with one name: not one person, not counted in linked_accounts_total, and no reason to ban. linked_accounts_total counts every linked account once, this player not included: the person holds linked_accounts_total + 1 accounts. It counts bank and holder-name links only: 0 is not proof the accounts are unrelated, and account_links checks browser, network, delivery address and real name. same_holder_name: true same name, false a different name, null no name to compare. banned = permanent ban; disabled = cannot log in (a ban, or staff); deleted = the account was deleted (its name and handle are gone, its payouts still count). disabled_at is UTC: say it in Malaysia time. Lifting the ban clears the saved banks and any name clearing; the player links a bank again. A banned number stays banned after an account unban: it is unbanned for one player with unban_bank_number. Why a player's own bank save is refused, and what fixes it: bank_save_check.",
  };
}

/** Every account on one bank number. */
async function numberView(db: ReportDb, key: string) {
  const accounts = await accountsOn(db, key);
  const payouts = await payoutsTo(db, key);
  const groups = nameGroups(accounts);
  // Every bank the number is at (the ban matches the digits at any bank).
  const bankRows = (
    await db.raw<{ bank_code: string }>(
      `SELECT a->>'bankCode' AS bank_code FROM customer c CROSS JOIN LATERAL ${SAVED}
        WHERE c.deleted_at IS NULL AND ${DIGITS("a->>'accountNumber'")} = ?
       UNION SELECT bank_code FROM gateway_withdrawal WHERE ${LIVE_PAYOUT} AND ${DIGITS('account_number')} = ?
       ORDER BY 1`,
      [key, key],
    )
  ).rows;
  return {
    bank_account: {
      banks: [
        ...new Set(
          bankRows.map((b) => findBank(b.bank_code)?.name ?? b.bank_code),
        ),
      ],
      last4: key.slice(-4),
      banned_number: await isBanned(db, key),
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
    note: 'Every account that saved this bank account or was paid to it (pending, held or settled), with its settled payouts to it in RM. Accounts with the same holder_name_group used the same account holder name; null = no name on file. One number on more than one account breaks one person, one account.',
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
    const key = payoutAccountKey(r.account_number, false);
    if (key.length <= 4) continue;
    const entry = byCustomer.get(r.customer_id) ?? {
      row: r,
      banks: new Map<string, string>(),
    };
    entry.banks.set(key, findBank(r.bank_code)?.name ?? r.bank_code);
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
