import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261029060836 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "assistant_schedule" ("id" text not null, "user_id" text not null, "title" text not null, "instruction" text not null, "every" text check ("every" in ('day', 'week')) not null, "at_time" text not null, "weekday" integer null, "enabled" boolean not null default true, "next_run_at" timestamptz not null, "last_run_at" timestamptz null, "last_error" text null, "conversation_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "assistant_schedule_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_assistant_schedule_deleted_at" ON "assistant_schedule" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_assistant_schedule_due" ON "assistant_schedule" ("enabled", "next_run_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "assistant_schedule" cascade;`);
  }

}
