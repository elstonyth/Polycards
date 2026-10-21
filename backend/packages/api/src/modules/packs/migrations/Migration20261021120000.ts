import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// pixel_pokemon.franchise + number: one sprite library, separate decks. Every
// existing row is a Pokémon (the default backfills them for free — no UPDATE),
// numbered by its dex as before; One Piece rows carry their own `number`.
export class Migration20261021120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `alter table if exists "pixel_pokemon" add column if not exists "franchise" text not null default 'pokemon';`,
    );
    this.addSql(
      `alter table if exists "pixel_pokemon" add column if not exists "number" integer null;`,
    );
    this.addSql(
      `create unique index if not exists "UQ_pixel_pokemon_franchise_number_normal" on "pixel_pokemon" ("franchise", "number") where variant = 'normal' and number is not null and deleted_at is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "UQ_pixel_pokemon_franchise_number_normal";`,
    );
    this.addSql(
      `alter table if exists "pixel_pokemon" drop column if exists "number";`,
    );
    this.addSql(
      `alter table if exists "pixel_pokemon" drop column if exists "franchise";`,
    );
  }
}
