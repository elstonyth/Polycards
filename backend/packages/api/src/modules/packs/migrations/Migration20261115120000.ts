import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// fx_rate_day — the effective USD->MYR rate for each MYT day, written by the
// hourly sync-usd-myr job (last write of the day wins). fx_rate keeps only the
// latest rate, so a report on a past month re-priced its cards at today's
// rate; the P&L report (owner 2026-11-15) prices a day at that day's rate.
// History starts at deploy. No model: only raw SQL reads and upserts it.
export class Migration20261115120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `create table if not exists "fx_rate_day" ("pair" text not null, "day" date not null, "rate" numeric not null, "recorded_at" timestamptz not null default now(), constraint "fx_rate_day_pkey" primary key ("pair", "day"));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "fx_rate_day";`);
  }
}
