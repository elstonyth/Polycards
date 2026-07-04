import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260703171356 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "pack" add column if not exists "published_odds" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pack" drop column if exists "published_odds";`);
  }

}
