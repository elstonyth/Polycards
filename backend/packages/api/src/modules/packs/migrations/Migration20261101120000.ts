import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// lucky_draw_event.tier: a gate's tier (economy, business, first), set by the
// operator. Every existing event reads as economy. Old code never reads it and
// its inserts take the default, so DEPLOY ORDER is the usual migrate-then-serve.
//
// Hand-written (the generator re-emits unrelated snapshot drift). lucky_draw_event
// is not in the snapshot, so ticket-spin-one-winner-schema.spec.ts pins this.
export class Migration20261101120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `alter table if exists "lucky_draw_event" add column if not exists "tier" text not null default 'economy';`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_event" drop constraint if exists "lucky_draw_event_tier_check";`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_event" add constraint "lucky_draw_event_tier_check" check ("tier" in ('economy', 'business', 'first'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "lucky_draw_event" drop constraint if exists "lucky_draw_event_tier_check";`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_event" drop column if exists "tier";`,
    );
  }
}
