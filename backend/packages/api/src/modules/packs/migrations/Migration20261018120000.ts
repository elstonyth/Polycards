import { Migration } from '@medusajs/framework/mikro-orm/migrations';

export class Migration20261018120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`create table if not exists "automation_monitor" (
      "id" text not null check ("id" = 'global'),
      "accounts" jsonb not null,
      "updated_by" text not null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz null,
      constraint "automation_monitor_pkey" primary key ("id")
    );`);
    this.addSql(
      `create index if not exists "IDX_automation_monitor_deleted_at" on "automation_monitor" ("deleted_at") where deleted_at is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "automation_monitor";`);
  }
}
