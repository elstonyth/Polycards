import { appendFileSync, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';

/**
 * Operator script (owner, 2026-11-03): clear every customer's saved bank
 * accounts and support's share stamps, so everyone saves again under the new
 * rules (name typed twice, banned numbers, one name per person, one account per
 * currency). Payout rows keep their own destination, so pending and held
 * payouts are untouched.
 *
 * Disabled accounts are skipped: a banned ring account keeps its saved names
 * and numbers, so the same-name and shared-number checks still see them.
 *
 * DRY RUN BY DEFAULT: counts what would be cleared.
 *   medusa exec ./src/scripts/reset-saved-banks.ts <backup.jsonl>
 * APPLY: one customer at a time under the same `metadata:` lock every writer of
 * the blob takes, so a concurrent avatar or bank save can't put the keys back.
 * Each cleared value is appended to <backup.jsonl> (an absolute path to a new
 * file off the repo: it holds account numbers) before that customer's write,
 * so a crash halfway leaves a backup of everything cleared. Safe to re-run.
 *   medusa exec ./src/scripts/reset-saved-banks.ts <backup.jsonl> apply
 */
export default async function resetSavedBanks({ container, args }: ExecArgs) {
  const [file, mode] = args;
  if (!file || !isAbsolute(file)) {
    throw new Error(
      'Usage: reset-saved-banks.ts <absolute backup.jsonl> [apply]',
    );
  }
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const db = (await knex.raw('SELECT current_database() AS db')).rows[0].db;
  const ids: string[] = (
    await knex.raw(
      `SELECT c.id FROM customer c
        WHERE c.deleted_at IS NULL
          AND (c.metadata->'bank_accounts' IS NOT NULL OR c.metadata->'bank_share_verified' IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM customer_account_state s
                           WHERE s.customer_id = c.id AND s.disabled = true AND s.deleted_at IS NULL)
        ORDER BY c.id`,
    )
  ).rows.map((r: { id: string }) => r.id);
  console.log(
    `database: ${db}; customers to clear: ${ids.length}; mode: ${mode ?? 'dry run'}`,
  );
  if (mode !== 'apply') {
    console.log('dry run: nothing written');
    return;
  }
  if (existsSync(file)) {
    console.log(`appending to the existing backup ${file}`);
  }

  let cleared = 0;
  let failed = 0;
  for (const customerId of ids) {
    try {
      await packs.mutateCustomerMetadata({
        customerId,
        mutate: (current) => {
          if (
            !('bank_accounts' in current) &&
            !('bank_share_verified' in current)
          ) {
            return null;
          }
          const { bank_accounts, bank_share_verified, ...rest } = current;
          appendFileSync(
            file,
            `${JSON.stringify({ customer_id: customerId, at: new Date().toISOString(), bank_accounts, bank_share_verified })}\n`,
          );
          cleared++;
          return rest;
        },
      });
    } catch (e) {
      failed++;
      console.log(
        `failed ${customerId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const left = (
    await knex.raw(
      `SELECT count(*)::int AS n FROM customer c
        WHERE c.deleted_at IS NULL
          AND (c.metadata->'bank_accounts' IS NOT NULL OR c.metadata->'bank_share_verified' IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM customer_account_state s
                           WHERE s.customer_id = c.id AND s.disabled = true AND s.deleted_at IS NULL)`,
    )
  ).rows[0].n;
  console.log(
    `cleared: ${cleared}; failed: ${failed}; still holding one: ${left}`,
  );
}
