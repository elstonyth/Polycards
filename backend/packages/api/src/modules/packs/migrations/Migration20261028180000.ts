import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// procurement_snapshot (owner, 2026-10-28): the to-buy list frozen by the
// 12am stock run, so purchasing works from one list a day. Additive; old code
// never reads it, so DEPLOY ORDER is the usual migrate-then-serve.
export class Migration20261028180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "procurement_snapshot" ("id" text not null, "taken_at" timestamptz not null, "to_buy" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "procurement_snapshot_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_procurement_snapshot_deleted_at" ON "procurement_snapshot" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_procurement_snapshot_taken_at" ON "procurement_snapshot" ("taken_at") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "procurement_snapshot" cascade;`);
  }
}
