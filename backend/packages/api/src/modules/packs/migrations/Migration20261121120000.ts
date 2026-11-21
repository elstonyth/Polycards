import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// The gateway's own id for the manual entry linked on Settlement
// (deposit-adjustment-entry.ts). The typed merchant reference may come in
// another letter case, so "one entry, one row" is keyed on this as well
// (review, 2026-11-21). Nullable, and old code never reads or writes it, so
// the usual migrate-then-serve order holds. Partial unique index, small
// table, built inside the migration.
export class Migration20261121120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      'alter table "gateway_deposit" add column if not exists "gateway_adjustment_entry_id" text null;',
    );
    this.addSql(
      `create unique index if not exists "IDX_gateway_deposit_adjustment_entry_id_unique" on "gateway_deposit" ("gateway_adjustment_entry_id") where "gateway_adjustment_entry_id" is not null and "gateway_adjustment_entry_id" <> '' and "deleted_at" is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop index if exists "IDX_gateway_deposit_adjustment_entry_id_unique";',
    );
    this.addSql(
      'alter table "gateway_deposit" drop column if exists "gateway_adjustment_entry_id";',
    );
  }
}
