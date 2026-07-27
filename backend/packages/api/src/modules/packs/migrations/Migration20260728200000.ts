import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Odds sets 2/3 (POLYCARD-BACK §2.4, D2): additive nullable bps columns on
// pack_odds. NULL = inherit previous set per card, so existing rows need no
// backfill (every pack starts as pure set-1 inheritance). Expand-safe.
export class Migration20260728200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "pack_odds" add column if not exists "weight_2" integer null;`,
    );
    this.addSql(
      `alter table if exists "pack_odds" add column if not exists "weight_3" integer null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pack_odds" drop column if exists "weight_3";`);
    this.addSql(`alter table if exists "pack_odds" drop column if exists "weight_2";`);
  }
}
