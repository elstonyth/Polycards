import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261029091053 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_assistant_conversation_user_all" ON "assistant_conversation" ("user_id", "last_message_at");`);

    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_assistant_message_conversation_role_all" ON "assistant_message" ("conversation_id", "role", "created_at");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_assistant_conversation_user_all";`);

    this.addSql(`drop index if exists "IDX_assistant_message_conversation_role_all";`);
  }

}
