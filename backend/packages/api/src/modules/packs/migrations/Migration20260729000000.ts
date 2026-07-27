import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Auto-split target RTP in basis points (7000 = 70%). Additive with a default,
// so existing packs backfill without a data migration. Expand-safe.
export class Migration20260729000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "pack" add column if not exists "target_rtp_bps" integer not null default 7000;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pack" drop column if exists "target_rtp_bps";`);
  }
}
