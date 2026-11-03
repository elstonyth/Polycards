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
 * The list is a local JSON file, never the repo (it is public):
 *   [{ "number": "...", "bank": "MBBEMYKL", "expected": 3, "handles": ["..."] }]
 *
 * DRY RUN BY DEFAULT: for each number, prints how many accounts saved it or were
 * paid to it against the owner's count, and any handle on one side only.
 *   medusa exec ./src/scripts/ban-shared-banks.ts <list.json>
 * APPLY: the third argument must equal the number of accounts the dry run says
 * it will ban, so a changed list cannot slip through:
 *   medusa exec ./src/scripts/ban-shared-banks.ts <list.json> apply <count>
 *
 * Apply writes each number to banned_payout_account, disables each listed
 * account with a "Permanent ban:" reason (audited, login and every session
 * refused), and denies its held withdrawals, so no admin can approve one later.
 * Only accounts on the owner's list are banned: one found on a number but not
 * listed is printed and left alone. Pending (already submitted) payouts cannot
 * be recalled and are printed.
 */

type ListRow = {
  number: string;
  bank?: string;
  expected?: number;
  handles: string[];
};

const REASON = `${PERMANENT_BAN_REASON_PREFIX} shared bank account, more than one account (owner, 2026-11-03)`;

export default async function banSharedBanks({ container, args }: ExecArgs) {
  const [file, mode, confirm] = args;
  if (!file)
    throw new Error('Usage: ban-shared-banks.ts <list.json> [apply <count>]');
  const list = JSON.parse(readFileSync(file, 'utf8')) as ListRow[];
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const log = (line: string) => console.log(line);

  const db = (await knex.raw('SELECT current_database() AS db')).rows[0].db;
  log(`database: ${db}; ${list.length} numbers; mode: ${mode ?? 'dry run'}`);

  const toBan = new Map<string, string>(); // customer id -> handle
  const keys: { key: string; bank: string | null }[] = [];
  for (const row of list) {
    const key = payoutAccountKey(row.number, false);
    keys.push({ key, bank: row.bank ?? null });
    const found: { id: string; handle: string | null }[] = (
      await knex.raw(
        `SELECT c.id, c.metadata->>'handle' AS handle FROM customer c
           CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.metadata->'bank_accounts') = 'array'
             THEN c.metadata->'bank_accounts' ELSE '[]'::jsonb END) a
          WHERE c.deleted_at IS NULL AND ltrim(regexp_replace(a->>'accountNumber', '[^0-9]', '', 'g'), '0') = ?
         UNION
         SELECT c.id, c.metadata->>'handle' AS handle FROM gateway_withdrawal w
           JOIN customer c ON c.id = w.customer_id AND c.deleted_at IS NULL
          WHERE w.deleted_at IS NULL AND ltrim(regexp_replace(w.account_number, '[^0-9]', '', 'g'), '0') = ?`,
        [key, key],
      )
    ).rows;
    const listed = new Set(row.handles.map((h) => h.toLowerCase()));
    const foundHandles = new Set(
      found.map((f) => (f.handle ?? '').toLowerCase()),
    );
    const notListed = found.filter(
      (f) => !listed.has((f.handle ?? '').toLowerCase()),
    );
    const notFound = row.handles.filter(
      (h) => !foundHandles.has(h.toLowerCase()),
    );
    for (const f of found) {
      if (listed.has((f.handle ?? '').toLowerCase()))
        toBan.set(f.id, f.handle ?? f.id);
    }
    log(
      `…${key.slice(-4)}: owner ${row.expected ?? row.handles.length}, found ${found.length}` +
        (notListed.length
          ? `; found, not listed: ${notListed.map((f) => f.handle ?? f.id).join(', ')}`
          : '') +
        (notFound.length ? `; listed, not found: ${notFound.join(', ')}` : ''),
    );
  }

  // Handles listed under a number they no longer show on (a saved list already
  // changed) are still the owner's ban: resolve them by handle.
  const allListed = [
    ...new Set(list.flatMap((r) => r.handles.map((h) => h.toLowerCase()))),
  ];
  const byHandle: { id: string; handle: string }[] = (
    await knex.raw(
      `SELECT id, metadata->>'handle' AS handle FROM customer
        WHERE deleted_at IS NULL AND lower(metadata->>'handle') = ANY(string_to_array(?, ','))`,
      [allListed.join(',')],
    )
  ).rows;
  for (const c of byHandle) toBan.set(c.id, c.handle);
  const missing = allListed.filter(
    (h) => !byHandle.some((c) => c.handle.toLowerCase() === h),
  );
  log(`accounts to ban: ${toBan.size} of ${allListed.length} listed handles`);
  if (missing.length)
    log(`listed handles with no live account: ${missing.join(', ')}`);

  const ids = [...toBan.keys()];
  const open: {
    id: string;
    customer_id: string;
    status: string;
    amount: string;
  }[] = (
    await knex.raw(
      `SELECT id, customer_id, status, amount::text FROM gateway_withdrawal
        WHERE deleted_at IS NULL AND status IN ('held', 'pending') AND customer_id = ANY(string_to_array(?, ','))`,
      [ids.join(',')],
    )
  ).rows;
  log(
    `their open payouts: ${open.filter((w) => w.status === 'held').length} held (denied on apply), ${open.filter((w) => w.status === 'pending').length} pending (cannot be recalled)`,
  );

  if (mode !== 'apply') {
    log('dry run: nothing written');
    return;
  }
  if (confirm !== String(ids.length)) {
    throw new Error(
      `apply needs the account count as the third argument (${ids.length})`,
    );
  }

  const users = container.resolve(Modules.USER);
  const [admin] = await users.listUsers(
    { email: 'admin@polycards.gg' },
    { take: 1 },
  );
  if (!admin) throw new Error('admin@polycards.gg not found');

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
    await packs.setAccountDisabled({
      customerId: id,
      adminId: admin.id,
      disabled: true,
      reason: REASON,
    });
    disabled++;
  }
  log(`accounts banned: ${disabled}`);

  for (const w of open.filter((r) => r.status === 'held')) {
    const result = await denyHeldWithdrawal(container, {
      withdrawalId: w.id,
      adminId: admin.id,
    });
    log(`denied held payout ${w.id}: ${JSON.stringify(result)}`);
  }
  for (const w of open.filter((r) => r.status === 'pending')) {
    log(
      `pending payout left with the gateway: ${w.id} (${toBan.get(w.customer_id)})`,
    );
  }
}
