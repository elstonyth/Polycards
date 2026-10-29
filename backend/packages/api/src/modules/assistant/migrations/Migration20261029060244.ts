import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261029060244 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "assistant_memory" ("id" text not null, "scope" text check ("scope" in ('user', 'shared')) not null, "user_id" text not null, "content" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "assistant_memory_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_assistant_memory_deleted_at" ON "assistant_memory" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_assistant_memory_scope_user" ON "assistant_memory" ("scope", "user_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "assistant_memory" cascade;`);
  }

}
