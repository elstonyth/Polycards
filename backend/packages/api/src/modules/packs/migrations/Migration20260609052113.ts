import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260609052113 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "card" add column if not exists "price" numeric null, add column if not exists "for_sale" boolean not null default true, add column if not exists "raw_price" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "card" drop column if exists "price", drop column if exists "for_sale", drop column if exists "raw_price";`);
  }

}
