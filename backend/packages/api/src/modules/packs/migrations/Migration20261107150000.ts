import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Delivery status 'pending_ship' (operator, 2026-11-07): packed but not posted
// yet, between ready_to_ship and shipped. The CHECK keeps Migration20260727000000's
// full union, legacy 'packing'/'delivered' included, and adds the new value.
//
// Hand-written. Old code never writes the new value, so DEPLOY ORDER is the
// usual migrate-then-serve. lock_timeout: the CHECK swap takes a short
// exclusive lock on delivery_order against live traffic; past 5 s it gives up
// and the deploy can be retried, rather than queueing every order write.
// NOT exported: the migration loader takes a migration file's first export as
// its class.
const BEFORE = [
  'requested',
  'packing',
  'processed',
  'ready_to_ship',
  'shipped',
  'delivered',
  'completed',
  'canceled',
];
const AFTER = [...BEFORE.slice(0, 4), 'pending_ship', ...BEFORE.slice(4)];

const swapCheck = (statuses: string[]): string[] => [
  `alter table if exists "delivery_order" drop constraint if exists "delivery_order_status_check";`,
  `alter table if exists "delivery_order" add constraint "delivery_order_status_check" check ("status" in (${statuses.map((s) => `'${s}'`).join(', ')}));`,
];

export class Migration20261107150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    for (const sql of swapCheck(AFTER)) this.addSql(sql);
  }

  override async down(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    // A packed order is still a ready_to_ship order to the old code: it only
    // shows on that tab again.
    this.addSql(
      `update "delivery_order" set "status" = 'ready_to_ship' where "status" = 'pending_ship';`,
    );
    for (const sql of swapCheck(BEFORE)) this.addSql(sql);
  }
}
