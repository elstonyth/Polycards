import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Task 1 — notification_read side table for per-customer read state.
// db:generate emitted the partial-unique index correctly (WHERE deleted_at IS NULL).
// Normalized: removed spurious ALTER TABLE ... DROP CONSTRAINT prefix (no-op guard
// from a prior dry-run); kept the rest verbatim.
export class Migration20260623212927 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "notification_read" ("id" text not null, "notification_id" text not null, "customer_id" text not null, "read_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "notification_read_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_read_deleted_at" ON "notification_read" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_notification_read_notification_id_customer_id_unique" ON "notification_read" ("notification_id", "customer_id") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "notification_read" cascade;`);
  }
}
