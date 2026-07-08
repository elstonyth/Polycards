import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260708135930 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "pixel_pokemon" ("id" text not null, "name" text not null, "dex" integer null, "variant" text not null default 'normal', "types" jsonb not null, "image_url" text null, "image_key" text null, "is_custom" boolean not null default false, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "pixel_pokemon_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pixel_pokemon_deleted_at" ON "pixel_pokemon" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "card" add column if not exists "pixel_pokemon_id" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "pixel_pokemon" cascade;`);

    this.addSql(`alter table if exists "card" drop column if exists "pixel_pokemon_id";`);
  }

}
