import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { findBank } from '../../../../modules/packs/banks';
import { payoutAccountKey } from '../../../../modules/packs/saved-accounts';
import { PERMANENT_BAN_REASON_PREFIX } from '../../../utils/disabled-guard';
import { realNameKeySql } from '../../../../utils/real-name';
import { findReportPlayer } from '../../player-lookup';
import { reportDb } from '../../sql';

// GET /reports/support/ban?username=: why a player's account is disabled, for
// support and the admin assistant (owner, 2026-11-03). A permanent ban for
// breaking the rules says so in its stored reason; for it, this lists each bank
// account the player saved or was paid to (bank name and last 4 digits only),
// whether that number is banned, and every other account on it with its shown
// name, handle, ban state and payouts. Holder names are compared, never shown.
// A disable typed by staff keeps its reason private, like the account report.
// No email, phone, customer id or full account number.

const PERMANENT_BAN_TEXT =
  'Permanent ban: the same bank account was used on more than one Polycards account (one person, one account).';

type NumberRow = { bank_code: string; account_number: string };
type Holder = {
  customer_id: string;
  username: string | null;
  handle: string | null;
  disabled: boolean | null;
  reason: string | null;
  same_name: boolean;
  deleted: boolean;
};

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id, lookupNote } = await findReportPlayer(req);
  const db = reportDb(req);
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
  const disabled = state?.disabled === true;
  const permanent =
    disabled &&
    (state?.disabled_reason ?? '').startsWith(PERMANENT_BAN_REASON_PREFIX);

  const saved = `jsonb_array_elements(CASE WHEN jsonb_typeof(c.metadata->'bank_accounts') = 'array' THEN c.metadata->'bank_accounts' ELSE '[]'::jsonb END) a`;
  const numbers = (
    await db.raw<NumberRow>(
      `SELECT a->>'bankCode' AS bank_code, a->>'accountNumber' AS account_number FROM customer c CROSS JOIN LATERAL ${saved} WHERE c.id = ?
       UNION SELECT bank_code, account_number FROM gateway_withdrawal
        WHERE deleted_at IS NULL AND customer_id = ? AND status IN ('pending', 'held', 'settled')
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

  const banks: Record<string, unknown>[] = [];
  for (const [key, row] of byKey) {
    const digits = `ltrim(regexp_replace(%s, '[^0-9]', '', 'g'), '0') = ?`;
    const holders = (
      await db.raw<Holder>(
        `WITH mine AS (
           SELECT NULLIF(${realNameKeySql("a->>'accountHolderName'")}, '') AS k FROM customer c CROSS JOIN LATERAL ${saved}
            WHERE c.id = ? AND ${digits.replace('%s', "a->>'accountNumber'")}
           UNION SELECT NULLIF(${realNameKeySql('account_holder_name')}, '') FROM gateway_withdrawal
            WHERE deleted_at IS NULL AND customer_id = ? AND status IN ('pending', 'held', 'settled') AND ${digits.replace('%s', 'account_number')}
         ), others AS (
           SELECT c.id AS customer_id, NULLIF(${realNameKeySql("a->>'accountHolderName'")}, '') AS k FROM customer c CROSS JOIN LATERAL ${saved}
            WHERE c.deleted_at IS NULL AND c.id <> ? AND ${digits.replace('%s', "a->>'accountNumber'")}
           UNION SELECT customer_id, NULLIF(${realNameKeySql('account_holder_name')}, '') FROM gateway_withdrawal
            WHERE deleted_at IS NULL AND customer_id <> ? AND status IN ('pending', 'held', 'settled')
              AND ${digits.replace('%s', 'account_number')}
         )
         SELECT o.customer_id, c.first_name AS username, c.metadata->>'handle' AS handle,
                c.deleted_at IS NOT NULL AS deleted, s.disabled, s.disabled_reason AS reason,
                bool_or(o.k IN (SELECT k FROM mine WHERE k IS NOT NULL)) AS same_name
           FROM others o JOIN customer c ON c.id = o.customer_id
           LEFT JOIN customer_account_state s ON s.customer_id = o.customer_id AND s.deleted_at IS NULL
          GROUP BY o.customer_id, c.id, s.id
          ORDER BY c.first_name`,
        [id, key, id, key, id, key, id, key],
      )
    ).rows;
    const paid = (
      await db.raw<{ customer_id: string; n: number; rm: string }>(
        `SELECT customer_id, count(*)::int AS n, coalesce(sum(amount), 0)::text AS rm FROM gateway_withdrawal
          WHERE deleted_at IS NULL AND status = 'settled' AND ${digits.replace('%s', 'account_number')}
          GROUP BY customer_id`,
        [key],
      )
    ).rows;
    const payouts = (customerId: string) => {
      const p = paid.find((r) => r.customer_id === customerId);
      return { count: p?.n ?? 0, rm: Number(p?.rm ?? 0) };
    };
    const banned =
      (
        await db.raw(
          'SELECT 1 FROM banned_payout_account WHERE account_key = ? LIMIT 1',
          [key],
        )
      ).rows.length > 0;
    banks.push({
      bank: findBank(row.bank_code)?.name ?? row.bank_code,
      last4: key.slice(-4),
      banned_number: banned,
      this_player_payouts: payouts(id),
      other_accounts: holders.map((h) => ({
        username: h.username,
        handle: h.handle,
        banned:
          h.disabled === true &&
          (h.reason ?? '').startsWith(PERMANENT_BAN_REASON_PREFIX),
        disabled: h.disabled === true,
        // Its payouts still count; the name and handle went with the deletion.
        deleted: h.deleted === true,
        same_holder_name: h.same_name === true,
        payouts: payouts(h.customer_id),
      })),
    });
  }

  res.json({
    disabled,
    permanent_ban: permanent,
    // Fixed text, never the stored one: staff-typed text stays out.
    reason: permanent
      ? PERMANENT_BAN_TEXT
      : disabled
        ? 'Disabled by staff (the reason is on the admin player page).'
        : null,
    disabled_at: disabled ? state?.disabled_at : null,
    bank_accounts: banks,
    ...(lookupNote ? { lookup_note: lookupNote } : {}),
    note: 'A permanent ban (owner, 2026-11-03) is for one person with more than one account: the same bank account was saved or paid out on more than one Polycards account. bank_accounts are every bank this player saved or was paid to, by bank name and last 4 digits; other_accounts are the other accounts on that same number, with their payouts to it (settled, RM). same_holder_name says whether they used the same account holder name. Lifting the ban clears the saved banks; the player links a bank again.',
  });
}
