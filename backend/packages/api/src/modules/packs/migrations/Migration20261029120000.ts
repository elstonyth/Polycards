import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// pack.pack_type + pack.language: admin tags for the One Piece launch (classic
// / original / special, and an original pack's language). Both nullable with
// no backfill: an untagged pack reads "—" in the admin list until someone sets
// it. The language rule is held here too, whatever the write path.
export class Migration20261029120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `alter table if exists "pack" add column if not exists "pack_type" text check ("pack_type" in ('classic', 'original', 'special')) null;`,
    );
    this.addSql(
      `alter table if exists "pack" add column if not exists "language" text check ("language" in ('en', 'jp')) null;`,
    );
    this.addSql(
      `alter table if exists "pack" drop constraint if exists "pack_language_original_check";`,
    );
    // `is not null and`: a bare `"pack_type" = 'original'` is NULL for an
    // untyped pack, and a CHECK lets NULL through.
    this.addSql(
      `alter table if exists "pack" add constraint "pack_language_original_check" check ("language" is null or ("pack_type" is not null and "pack_type" = 'original'));`,
    );
  }

  // Rolling back drops every pack's tags with the columns. Re-tag the packs
  // in the admin after up() runs again.
  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "pack" drop constraint if exists "pack_language_original_check";`,
    );
    this.addSql(
      `alter table if exists "pack" drop column if exists "language";`,
    );
    this.addSql(
      `alter table if exists "pack" drop column if exists "pack_type";`,
    );
  }
}
