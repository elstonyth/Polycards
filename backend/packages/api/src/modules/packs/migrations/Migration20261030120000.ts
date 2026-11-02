import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// delivery_order.tracking_snapshot: the shipment tracker's last carrier check
// (shipment-tracking.ts TrackingSnapshot). Nullable, no backfill — the first
// tracker run fills it for every shipped order. Old code never reads it, so
// DEPLOY ORDER is the usual migrate-then-serve.
//
// Hand-written (the generator re-emits unrelated snapshot drift).
export class Migration20261030120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `alter table if exists "delivery_order" add column if not exists "tracking_snapshot" jsonb null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "delivery_order" drop column if exists "tracking_snapshot";`,
    );
  }
}
