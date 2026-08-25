import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Mercur migration-name collision repair (mercur 2.3.1 upgrade).
//
// @mercurjs/core's media/review/offer modules ship migrations named
// Migration20260616000000, Migration20260729120000 and Migration20260804000000
// — the same class names three packs migrations used. All module migrators
// share one mikro_orm_migrations ledger keyed by NAME, so whichever module
// runs a name first causes the other module's same-named migration to be
// silently skipped. On fresh databases mercur's modules run before packs and
// OUR three were skipped (observed: customer_account_state.phone_verified_at
// missing, every customer.created drain timing out). The packs three are now
// renamed *0010 so both sides run on fresh databases.
//
// This migration covers the inverse hole: databases that recorded the OLD
// packs names (production, existing dev) will skip MERCUR's three forever.
// Their bodies are fully idempotent, so we mirror them here verbatim. On
// fresh databases mercur has already run them and every statement no-ops.
export class Migration20260826000000 extends Migration {
  override async up(): Promise<void> {
    // media module — Migration20260616000000
    this.addSql(
      `create table if not exists "media_image" ("id" text not null, "url" text not null, "type" text null, "is_thumbnail" boolean not null default false, "is_banner" boolean not null default false, "rank" integer not null default 0, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "media_image_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_media_image_type" ON "media_image" ("type") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_media_image_deleted_at" ON "media_image" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    // review module — Migration20260729120000
    this.addSql(
      `create table if not exists "review" ("id" text not null, "display_id" serial, "reference" text check ("reference" in ('product', 'seller')) not null, "rating" integer not null, "customer_note" text null, "seller_note" text null, "status" text check ("status" in ('pending', 'published', 'rejected')) not null default 'pending', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "review_pkey" primary key ("id"));`,
    );
    this.addSql(
      `alter table if exists "review" add column if not exists "display_id" serial;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_review_deleted_at" ON "review" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    // offer module — Migration20260804000000
    this.addSql(
      `ALTER TABLE IF EXISTS "offer" ADD COLUMN IF NOT EXISTS "manage_inventory" boolean NOT NULL DEFAULT true;`,
    );
    this.addSql(
      `ALTER TABLE IF EXISTS "offer" ADD COLUMN IF NOT EXISTS "allow_backorder" boolean NOT NULL DEFAULT false;`,
    );
  }

  override async down(): Promise<void> {
    // Never roll back another module's schema from here — mercur's own
    // migrations stay the owner of these tables. Intentional no-op.
  }
}
