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
    // The decks never cross, whatever the write path (the admin parser is the
    // only one today): a Pokémon has no `number`, any other deck no `dex` — a
    // One Piece row with a dex would be mirrored onto cards as that Pokémon.
    // Every existing row is a Pokémon with a null number, so it validates.
    this.addSql(
      `alter table if exists "pixel_pokemon" drop constraint if exists "pixel_pokemon_deck_numbering_check";`,
    );
    this.addSql(
      `alter table if exists "pixel_pokemon" add constraint "pixel_pokemon_deck_numbering_check" check (("franchise" = 'pokemon' and "number" is null) or ("franchise" <> 'pokemon' and "dex" is null));`,
    );
  }

  // Rolling back loses which rows are One Piece: up() again relabels them all
  // 'pokemon' (the default). Re-run the sprite uploader's rows by hand after.
  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "pixel_pokemon" drop constraint if exists "pixel_pokemon_deck_numbering_check";`,
    );
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
