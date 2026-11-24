import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Guaranteed win (2026-11-24): a one_winner Lucky Draw event can carry an
// admin-picked winner the draw job pays whatever the seed says. Nullable, and
// old code never reads or writes it, so the usual migrate-then-serve order
// holds. Small table, plain ALTER.
export class Migration20261124120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      'alter table if exists "lucky_draw_event" add column if not exists "forced_winner_id" text null;',
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      'alter table if exists "lucky_draw_event" drop column if exists "forced_winner_id";',
    );
  }
}
