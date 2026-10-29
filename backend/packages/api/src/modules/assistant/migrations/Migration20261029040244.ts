import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261029040244 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "assistant_conversation" ("id" text not null, "user_id" text not null, "title" text not null, "last_message_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "assistant_conversation_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_assistant_conversation_deleted_at" ON "assistant_conversation" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_assistant_conversation_user_id" ON "assistant_conversation" ("user_id", "last_message_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "assistant_message" ("id" text not null, "conversation_id" text not null, "role" text check ("role" in ('user', 'assistant')) not null, "content" text not null, "attachments" integer not null default 0, "images" jsonb null, "tools" jsonb null, "model" text null, "cost_usd" real not null default 0, "tokens_in" integer not null default 0, "tokens_out" integer not null default 0, "error" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "assistant_message_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_assistant_message_deleted_at" ON "assistant_message" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_assistant_message_conversation_id" ON "assistant_message" ("conversation_id", "created_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "assistant_settings" ("id" text not null, "openrouter_key_sealed" text null, "openrouter_key_last4" text null, "chat_model" text not null default 'anthropic/claude-sonnet-5.5', "image_model" text not null default 'google/gemini-3.1-flash-image', "daily_cap_usd" real not null default 20, "updated_by" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "assistant_settings_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_assistant_settings_deleted_at" ON "assistant_settings" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "assistant_conversation" cascade;`);

    this.addSql(`drop table if exists "assistant_message" cascade;`);

    this.addSql(`drop table if exists "assistant_settings" cascade;`);
  }

}
