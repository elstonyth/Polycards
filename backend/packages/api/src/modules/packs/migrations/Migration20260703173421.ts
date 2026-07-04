import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260703173421 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "pack_odds" add column if not exists "top_hit" boolean not null default false;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pack_odds" drop column if exists "top_hit";`);
  }

}
