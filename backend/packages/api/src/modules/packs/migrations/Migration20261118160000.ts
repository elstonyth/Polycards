import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// The gateway's manual entry behind a short payment credited by hand
// (deposit-adjustment-entry.ts): the audit checks it in place of the order the
// gateway keeps FAILED. Nullable, and old code never reads or writes it, so the
// usual migrate-then-serve order holds. One entry backs one row: a partial
// unique index, small table, built inside the migration.
export class Migration20261118160000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      'alter table "gateway_deposit" add column if not exists "gateway_adjustment_ref" text null;',
    );
    this.addSql(
      'create unique index if not exists "IDX_gateway_deposit_adjustment_ref_unique" on "gateway_deposit" ("gateway_adjustment_ref") where "gateway_adjustment_ref" is not null and "deleted_at" is null;',
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop index if exists "IDX_gateway_deposit_adjustment_ref_unique";',
    );
    this.addSql(
      'alter table "gateway_deposit" drop column if exists "gateway_adjustment_ref";',
    );
  }
}
