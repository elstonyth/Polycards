import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Runtime gateway switch (plan 130). site_settings.payment_gateway holds the
// admin's choice (NULL = env fallback); every deposit/withdrawal row records
// the gateway it was created under, defaulting existing rows to GlobePay —
// the only gateway that has ever created a row before this migration.
export class Migration20260905130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table if exists "site_settings"
        add column if not exists "payment_gateway" text null;
    `);
    this.addSql(`
      alter table if exists "globepay_deposit"
        add column if not exists "gateway" text not null default 'globepay';
    `);
    this.addSql(`
      alter table if exists "globepay_withdrawal"
        add column if not exists "gateway" text not null default 'globepay';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "site_settings" drop column if exists "payment_gateway";`);
    this.addSql(`alter table if exists "globepay_deposit" drop column if exists "gateway";`);
    this.addSql(`alter table if exists "globepay_withdrawal" drop column if exists "gateway";`);
  }
}
