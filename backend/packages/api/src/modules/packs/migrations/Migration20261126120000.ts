import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// card_art — the clean (stamp-free) image of each card printing, keyed by its
// code ("OP05-119", "OP05-119_p3"). The admin uploads them in bulk; the
// PriceCharting import attaches the matching one instead of PriceCharting's
// photo (owner 2026-11-26). No model: only raw SQL reads and upserts it. New
// table, nothing reads it before this deploy.
export class Migration20261126120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `create table if not exists "card_art" ("code" text not null, "image_url" text not null, "updated_at" timestamptz not null default now(), constraint "card_art_pkey" primary key ("code"));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "card_art";`);
  }
}
