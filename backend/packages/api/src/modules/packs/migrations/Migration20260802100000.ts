import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// pack.tier_ranges — per-pack tier price-range override (NULL = inherit the
// global tier_settings singleton). See Migration20260802000000 for the global
// half of the feature.
export class Migration20260802100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "pack" add column if not exists "tier_ranges" jsonb null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "pack" drop column if exists "tier_ranges";`,
    );
  }
}
