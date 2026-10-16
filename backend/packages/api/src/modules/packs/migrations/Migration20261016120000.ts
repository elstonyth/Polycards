import { Migration } from '@medusajs/framework/mikro-orm/migrations';

export class Migration20261016120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `alter table if exists "card" add column if not exists "pc_pending_price" jsonb null, add column if not exists "pc_sync_error" text null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "card" drop column if exists "pc_pending_price", drop column if exists "pc_sync_error";`,
    );
  }
}
