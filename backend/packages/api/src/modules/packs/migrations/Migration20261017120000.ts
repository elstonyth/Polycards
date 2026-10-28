import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// lossless_schedule — admin-scheduled Lossless Mode windows (instant buyback
// pays 100% inside them). See models/lossless-schedule.ts. A brand-new table:
// nothing existing is altered, so up()/down() touch only this one.
export class Migration20261017120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `create table if not exists "lossless_schedule" ("id" text not null, "starts_at" timestamptz not null, "ends_at" timestamptz not null, "pack_slugs" jsonb null, "cancelled_at" timestamptz null, "created_by" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lossless_schedule_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lossless_schedule_deleted_at" ON "lossless_schedule" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    // The losslessWindows read: windows that have not yet ended, live rows only.
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lossless_schedule_ends_at" ON "lossless_schedule" ("ends_at") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "lossless_schedule" cascade;`);
  }
}
