import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261029054815 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "assistant_settings" add column if not exists "image_style" text null, add column if not exists "style_refs" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "assistant_settings" drop column if exists "image_style", drop column if exists "style_refs";`);
  }

}
