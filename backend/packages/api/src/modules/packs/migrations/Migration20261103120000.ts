import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// visitor_signal: which network and browser an account was seen on (ADR 0016).
// A new table, so nothing waits on a lock and old code never reads it. Hand-written
// (the generator re-emits unrelated snapshot drift), in the shape `db:generate`
// would produce.
export class Migration20261103120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "visitor_signal" ("id" text not null, "customer_id" text not null, "ip" text not null, "device_id" text not null default '', "first_seen_at" timestamptz not null, "last_seen_at" timestamptz not null, "hits" integer not null default 1, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "visitor_signal_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_visitor_signal_deleted_at" ON "visitor_signal" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_visitor_signal_customer_ip_device" ON "visitor_signal" ("customer_id", "ip", "device_id");`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_visitor_signal_ip" ON "visitor_signal" ("ip");`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_visitor_signal_device" ON "visitor_signal" ("device_id") WHERE device_id <> '';`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_visitor_signal_last_seen" ON "visitor_signal" ("last_seen_at");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "visitor_signal" cascade;`);
  }
}
