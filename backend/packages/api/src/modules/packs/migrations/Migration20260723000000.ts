import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Buyback instant-window close stamp. The instant (pack-rate) buyback premium
// used to be purely time-based (30s from reveal), so the vault leaked it for up
// to 30s after a pull. `instant_closed_at` is set the moment the reveal ends or
// the customer leaves it; once set, resolveBuybackRate forces the flat vault
// rate regardless of the 30s timer. Nullable + forward-only: existing rows are
// past their window anyway, so a NULL reads as "closed by time" already.
export class Migration20260723000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "pull" add column if not exists "instant_closed_at" timestamptz null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "pull" drop column if exists "instant_closed_at";`,
    );
  }
}
