import { Migration } from '@medusajs/framework/mikro-orm/migrations';

export class Migration20260708164353 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pixel_pokemon_dex_normal" ON "pixel_pokemon" ("dex") WHERE variant = 'normal' AND deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "UQ_pixel_pokemon_dex_normal";`);
  }
}
