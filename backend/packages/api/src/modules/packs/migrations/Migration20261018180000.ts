import { Migration } from '@medusajs/framework/mikro-orm/migrations';

export class Migration20261018180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`create table if not exists "automation_live" (
      "id" text not null check ("id" = 'global'),
      "state" jsonb not null check ("state"->>'mode' = 'live'),
      "updated_by" text not null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz null,
      constraint "automation_live_pkey" primary key ("id")
    );`);
    this.addSql(
      `create index if not exists "IDX_automation_live_deleted_at" on "automation_live" ("deleted_at") where deleted_at is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "automation_live";`);
  }
}
