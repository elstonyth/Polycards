import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260609112655 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "pack" add column if not exists "buyback_percent" integer not null default 90, add column if not exists "in_stock" boolean not null default true;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pack" drop column if exists "buyback_percent", drop column if exists "in_stock";`);
  }

}
