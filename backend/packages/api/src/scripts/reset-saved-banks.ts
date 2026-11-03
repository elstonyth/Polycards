import { existsSync, writeFileSync } from 'node:fs';
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';

/**
 * Operator script (owner, 2026-11-03): clear every customer's saved bank
 * accounts and support's share stamps, so everyone saves again under the new
 * rules (name typed twice, banned numbers, one name per person, one account per
 * currency). Payout rows keep their own destination, so pending and held
 * payouts are untouched.
 *
 * DRY RUN BY DEFAULT: counts what would be cleared.
 *   medusa exec ./src/scripts/reset-saved-banks.ts <backup.json>
 * APPLY: writes every cleared value to <backup.json> first (a new file, kept off
 * the repo: it holds account numbers), then clears them in one statement that
 * edits each row's current blob, so a key another writer sets meanwhile stays.
 *   medusa exec ./src/scripts/reset-saved-banks.ts <backup.json> apply
 */
export default async function resetSavedBanks({ container, args }: ExecArgs) {
  const [file, mode] = args;
  if (!file)
    throw new Error('Usage: reset-saved-banks.ts <backup.json> [apply]');
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const where =
    "(metadata->'bank_accounts' IS NOT NULL OR metadata->'bank_share_verified' IS NOT NULL)";

  const db = (await knex.raw('SELECT current_database() AS db')).rows[0].db;
  const rows: {
    id: string;
    bank_accounts: unknown;
    bank_share_verified: unknown;
  }[] = (
    await knex.raw(
      `SELECT id, metadata->'bank_accounts' AS bank_accounts, metadata->'bank_share_verified' AS bank_share_verified
         FROM customer WHERE ${where}`,
    )
  ).rows;
  console.log(
    `database: ${db}; customers with saved banks or stamps: ${rows.length}; mode: ${mode ?? 'dry run'}`,
  );
  if (mode !== 'apply') {
    console.log('dry run: nothing written');
    return;
  }
  if (existsSync(file))
    throw new Error(`${file} already exists: pick a new backup path`);
  writeFileSync(
    file,
    JSON.stringify({ taken_at: new Date().toISOString(), rows }, null, 1),
  );
  console.log(`backup written: ${rows.length} rows`);

  const updated = await knex.raw(
    `UPDATE customer SET metadata = metadata - 'bank_accounts' - 'bank_share_verified' WHERE ${where}`,
  );
  const left = (
    await knex.raw(`SELECT count(*)::int AS n FROM customer WHERE ${where}`)
  ).rows[0].n;
  console.log(`cleared: ${updated.rowCount}; still holding one: ${left}`);
}
