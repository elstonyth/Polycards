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
    this.addSql(
      `alter table if exists "pack" add constraint "pack_language_original_check" check ("language" is null or "pack_type" = 'original');`,
    );
  }

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
