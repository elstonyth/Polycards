import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Rename the GlobePay-era tables to their gateway-neutral names (operator,
// 2026-09-07: "we no longer use GlobePay, remove it, we use TGPay"). The rows
// are money history and do not move: this is RENAME only, never drop+create.
//
// Every constraint and index whose name embeds the old table name is renamed
// from the catalogue rather than from a hand-kept list, so a database built
// by the hand-written migrations (IDX_globepay_deposit_customer_id, the
// *_status_check constraints, UQ_globepay_withdrawal_customer_idempotency_key)
// and one whose names drifted both end up consistent. Renaming the PRIMARY
// KEY constraint renames its index with it. Neither table owns a sequence
// (text ids), but the loop covers one for completeness.
//
// Guarded: if BOTH names exist the migration refuses rather than guess which
// table is the real one. Idempotent: a second run finds the new table and
// nothing left to rename. down() is the exact mirror, and just as lossless.

const TABLES: ReadonlyArray<readonly [string, string]> = [
  ['globepay_deposit', 'gateway_deposit'],
  ['globepay_withdrawal', 'gateway_withdrawal'],
];

function renameTableSql(from: string, to: string): string {
  return `
DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public."${from}"') IS NOT NULL
     AND to_regclass('public."${to}"') IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to rename ${from}: ${to} already exists';
  END IF;
  IF to_regclass('public."${from}"') IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I RENAME TO %I', '${from}', '${to}');
  END IF;
  IF to_regclass('public."${to}"') IS NULL THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = to_regclass('public."${to}"')
      AND position('${from}' IN conname) > 0
  LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
      '${to}', r.conname, replace(r.conname, '${from}', '${to}'));
  END LOOP;
  FOR r IN
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = '${to}'
      AND position('${from}' IN indexname) > 0
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I',
      r.indexname, replace(r.indexname, '${from}', '${to}'));
  END LOOP;
  FOR r IN
    SELECT s.relname FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid AND d.deptype = 'a'
    WHERE s.relkind = 'S'
      AND d.refobjid = to_regclass('public."${to}"')
      AND position('${from}' IN s.relname) > 0
  LOOP
    EXECUTE format('ALTER SEQUENCE %I RENAME TO %I',
      r.relname, replace(r.relname, '${from}', '${to}'));
  END LOOP;
END $$;`;
}

export class Migration20260907120000 extends Migration {
  override async up(): Promise<void> {
    for (const [from, to] of TABLES) this.addSql(renameTableSql(from, to));
  }

  override async down(): Promise<void> {
    for (const [from, to] of TABLES) this.addSql(renameTableSql(to, from));
  }
}
