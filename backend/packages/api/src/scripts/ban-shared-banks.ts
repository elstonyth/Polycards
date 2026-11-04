import { readFileSync } from 'node:fs';
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { denyHeldWithdrawal } from '../modules/packs/gateway-withdrawal';
import { payoutAccountKey } from '../modules/packs/saved-accounts';
import { PERMANENT_BAN_REASON_PREFIX } from '../api/utils/disabled-guard';

/**
 * Operator script (owner, 2026-11-03): ban the bank numbers the farm rings
 * shared, and every account on the owner's list for them, for good.
 *
 * The list is a local JSON file, never the repo (it is public). Bank numbers
 * only, no wallets:
 *   [{ "number": "...", "bank": "MBBEMYKL", "expected": 3, "handles": ["..."] }]
 *
 * DRY RUN BY DEFAULT: for each number, how many live accounts saved it or were
 * paid to it against the owner's count, and any handle on one side only; then
 * the accounts it will ban, including those matched by handle alone.
 *   medusa exec ./src/scripts/ban-shared-banks.ts <list.json>
 * APPLY: the third argument must equal the number of accounts the dry run says
 * it will ban, so a changed list cannot slip through:
 *   medusa exec ./src/scripts/ban-shared-banks.ts <list.json> apply <count>
 *
 * Apply writes each number to banned_payout_account, disables each listed
 * account with a "Permanent ban:" reason (audited; login and every session
 * refused), then denies its held withdrawals so no admin can approve one later.
 * Only accounts on the owner's list are banned: one found on a number but not
 * listed is printed and left alone. Pending (already submitted) payouts cannot
 * be recalled and are printed. Safe to re-run: done steps are skipped.
 * Keep the admin Withdraw switch off while it runs.
 */

type ListRow = {
  number: string;
  bank?: string;
  expected?: number;
  handles: string[];
};

const REASON = `${PERMANENT_BAN_REASON_PREFIX} shared bank account, more than one account (owner, 2026-11-03)`;

const normHandle = (h: string) => h.trim().replace(/^@/, '').toLowerCase();

export default async function banSharedBanks({ container, args }: ExecArgs) {
  const [file, mode, confirm] = args;
  if (!file)
    throw new Error('Usage: ban-shared-banks.ts <list.json> [apply <count>]');
  const list = JSON.parse(readFileSync(file, 'utf8')) as ListRow[];
  for (const row of list) {
    if (!/^[\d\s-]+$/.test(row.number)) {
      throw new Error(
        `not a bank number (wallets are not supported): …${row.number.slice(-4)}`,
      );
    }
    if (payoutAccountKey(row.number, false).length <= 4) {
      throw new Error(
        `number too short to ban safely: …${row.number.slice(-4)}`,
      );
    }
    row.handles = row.handles.map(normHandle);
    if (row.handles.some((h) => h === '')) {
      throw new Error(`empty handle on …${row.number.slice(-4)}`);
    }
  }
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const log = (line: string) => console.log(line);

  const db = (await knex.raw('SELECT current_database() AS db')).rows[0].db;
  const users = container.resolve(Modules.USER);
  const [admin] = await users.listUsers(
    { email: 'admin@polycards.gg' },
    { take: 1 },
  );
  if (!admin) throw new Error('admin@polycards.gg not found');
  log(
    `database: ${db}; ${list.length} numbers; admin found; mode: ${mode ?? 'dry run'}`,
  );

  const toBan = new Map<string, string>(); // customer id -> handle
  const onNumbers = new Set<string>();
  const keys: { key: string; bank: string | null }[] = [];
  for (const row of list) {
    const key = payoutAccountKey(row.number, false);
    keys.push({ key, bank: row.bank ?? null });
    // An old handle kept as metadata.handle_alias (the 2026-11-04 8-digit
    // backfill) is still that player: a list written before it names them by it.
    const found: { id: string; handle: string | null; alias: string | null }[] = (
      await knex.raw(
        `SELECT c.id, c.metadata->>'handle' AS handle, c.metadata->>'handle_alias' AS alias FROM customer c
           CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.metadata->'bank_accounts') = 'array'
             THEN c.metadata->'bank_accounts' ELSE '[]'::jsonb END) a
          WHERE c.deleted_at IS NULL AND ltrim(regexp_replace(a->>'accountNumber', '[^0-9]', '', 'g'), '0') = ?
         UNION
         SELECT c.id, c.metadata->>'handle' AS handle, c.metadata->>'handle_alias' AS alias FROM gateway_withdrawal w
           JOIN customer c ON c.id = w.customer_id AND c.deleted_at IS NULL
          WHERE w.deleted_at IS NULL AND w.status IN ('pending', 'held', 'settled')
            AND ltrim(regexp_replace(w.account_number, '[^0-9]', '', 'g'), '0') = ?`,
        [key, key],
      )
    ).rows;
    const listed = new Set(row.handles);
    const handleOf = (f: { handle: string | null }) =>
      (f.handle ?? '').toLowerCase();
    const isListed = (f: { handle: string | null; alias: string | null }) =>
      (!!f.handle && listed.has(handleOf(f))) ||
      (!!f.alias && listed.has(f.alias.toLowerCase()));
    const notListed = found.filter((f) => !isListed(f));
    const foundHandles = new Set(
      found.flatMap((f) => [handleOf(f), (f.alias ?? '').toLowerCase()]),
    );
    const notFound = row.handles.filter((h) => !foundHandles.has(h));
    for (const f of found) {
      onNumbers.add(f.id);
      if (isListed(f)) toBan.set(f.id, f.handle ?? f.alias ?? f.id);
    }
    log(
      `…${key.slice(-4)}: owner ${row.expected ?? row.handles.length}, found ${found.length}` +
        (notListed.length
          ? `; found, NOT listed (left alone): ${notListed.map((f) => f.handle ?? f.id).join(', ')}`
          : '') +
        (notFound.length
          ? `; listed, not on this number: ${notFound.join(', ')}`
          : ''),
    );
  }

  // A listed handle no longer on its number (its saved list changed) is still
  // the owner's ban: resolve it by handle, and say so.
  const allListed = [...new Set(list.flatMap((r) => r.handles))];
  const byHandle: { id: string; handle: string; alias: string | null }[] = (
    await knex.raw(
      `SELECT id, metadata->>'handle' AS handle, metadata->>'handle_alias' AS alias FROM customer
        WHERE deleted_at IS NULL AND (lower(metadata->>'handle') = ANY(string_to_array(?, ','))
          OR lower(metadata->>'handle_alias') = ANY(string_to_array(?, ',')))`,
      [allListed.join(','), allListed.join(',')],
    )
  ).rows;
  const handleOnly = byHandle.filter((c) => !onNumbers.has(c.id));
  for (const c of byHandle) toBan.set(c.id, c.handle);
  const missing = allListed.filter(
    (h) =>
      !byHandle.some(
        (c) => c.handle.toLowerCase() === h || c.alias?.toLowerCase() === h,
      ),
  );
  if (handleOnly.length) {
    log(
      `banned by handle only (on none of the numbers now): ${handleOnly.map((c) => c.handle).join(', ')}`,
    );
  }
  if (missing.length)
    log(`listed handles with no live account: ${missing.join(', ')}`);

  const ids = [...toBan.keys()];
  const already = new Set<string>(
    (
      await knex.raw(
        `SELECT customer_id FROM customer_account_state
          WHERE deleted_at IS NULL AND disabled = true AND disabled_reason LIKE ?
            AND customer_id = ANY(string_to_array(?, ','))`,
        [`${PERMANENT_BAN_REASON_PREFIX}%`, ids.join(',')],
      )
    ).rows.map((r: { customer_id: string }) => r.customer_id),
  );
  const openPayouts = async () =>
    (
      await knex.raw(
        `SELECT id, customer_id, status FROM gateway_withdrawal
          WHERE deleted_at IS NULL AND status IN ('held', 'pending') AND customer_id = ANY(string_to_array(?, ','))`,
        [ids.join(',')],
      )
    ).rows as { id: string; customer_id: string; status: string }[];
  const open = await openPayouts();
  log(
    `accounts to ban: ${ids.length} (${already.size} already banned) of ${allListed.length} listed handles; ` +
      `their open payouts: ${open.filter((w) => w.status === 'held').length} held (denied on apply), ` +
      `${open.filter((w) => w.status === 'pending').length} pending (cannot be recalled)`,
  );

  if (mode !== 'apply') {
    log('dry run: nothing written');
    return;
  }
  // medusa exec hands a numeric argument over as a number.
  if (String(confirm) !== String(ids.length)) {
    throw new Error(
      `apply needs the account count as the third argument (${ids.length})`,
    );
  }

  for (const { key, bank } of keys) {
    await knex.raw(
      `INSERT INTO banned_payout_account (account_key, bank_code, reason) VALUES (?, ?, ?)
       ON CONFLICT (account_key) DO NOTHING`,
      [key, bank, 'Shared by more than one account (owner, 2026-11-03)'],
    );
  }
  log(`banned numbers: ${keys.length}`);

  let disabled = 0;
  for (const id of ids) {
    if (already.has(id)) continue;
    await packs.setAccountDisabled({
      customerId: id,
      adminId: admin.id,
      disabled: true,
      reason: REASON,
    });
    disabled++;
  }
  log(`accounts banned now: ${disabled}; already banned: ${already.size}`);

  // Read again after the bans: a payout held in between is denied too.
  const after = await openPayouts();
  const failures: string[] = [];
  for (const w of after.filter((r) => r.status === 'held')) {
    try {
      const result = await denyHeldWithdrawal(container, {
        withdrawalId: w.id,
        adminId: admin.id,
      });
      log(`denied held payout ${w.id}: ${JSON.stringify(result)}`);
    } catch (e) {
      failures.push(`${w.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const w of after.filter((r) => r.status === 'pending')) {
    log(
      `pending payout left with the gateway: ${w.id} (${toBan.get(w.customer_id)})`,
    );
  }
  if (failures.length)
    log(`deny FAILED, finish these in admin: ${failures.join('; ')}`);
}
