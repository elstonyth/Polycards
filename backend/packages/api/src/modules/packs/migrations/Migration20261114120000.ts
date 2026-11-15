import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// site_settings.pricecharting_feed — a PriceCharting feed outage (expired or
// missing token) seen by the daily sync-market-prices job, so admin shows one
// "token expired" alert instead of one price issue per card (2026-10-19: 877).
// One nullable jsonb column on the singleton; NULL = feed fine, as today.
export class Migration20261114120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `alter table if exists "site_settings" add column if not exists "pricecharting_feed" jsonb null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "site_settings" drop column if exists "pricecharting_feed";`,
    );
  }
}
