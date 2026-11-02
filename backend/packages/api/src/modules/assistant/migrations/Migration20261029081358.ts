import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261029081358 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "assistant_message" drop constraint if exists "assistant_message_role_check";`);

    this.addSql(`alter table if exists "assistant_message" add constraint "assistant_message_role_check" check("role" in ('user', 'assistant', 'voice'));`);

    this.addSql(`alter table if exists "assistant_settings" add column if not exists "stt_model" text not null default 'google/gemini-3.5-flash-lite', add column if not exists "voice_model" text not null default 'google/gemini-3.8-flash-lite-tts', add column if not exists "voice" text not null default 'Kore';`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "assistant_message" drop constraint if exists "assistant_message_role_check";`);

    // The narrower check fails while any voice row exists.
    this.addSql(`delete from "assistant_message" where "role" = 'voice';`);

    this.addSql(`alter table if exists "assistant_message" add constraint "assistant_message_role_check" check("role" in ('user', 'assistant'));`);

    this.addSql(`alter table if exists "assistant_settings" drop column if exists "stt_model", drop column if exists "voice_model", drop column if exists "voice";`);
  }

}
