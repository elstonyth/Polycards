import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Meta Pixel conversion reporting (store/credits/deposit/unreported). The
// storefront reports each settled deposit as a Purchase, then acks it here —
// on the row, so a customer's devices don't each report it.
//
// Backfill: every deposit already settled is marked reported. Those predate
// tracking, and reporting them now would replay history into the ads data.
// updated_at is deliberately left alone: this is bookkeeping, not a change to
// the deposit.
//
// lock_timeout: this runs in the pre-deploy job against live traffic, and the
// ALTER's lock queues every later gateway_deposit query behind it (callbacks,
// the sweep, the pending read) while it waits. Better to fail the deploy fast
// and retry than to stall payments.
export class Migration20260928120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`
      alter table if exists "gateway_deposit"
        add column if not exists "pixel_reported_at" timestamptz null;
    `);
    this.addSql(`
      update "gateway_deposit"
        set "pixel_reported_at" = now()
        where "status" = 'settled' and "pixel_reported_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table if exists "gateway_deposit"
        drop column if exists "pixel_reported_at";
    `);
  }
}
