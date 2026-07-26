import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Delivery pipeline rename (POLYCARD-BACK §1.2): packing→processed,
// delivered→completed, new ready_to_ship. Old check constraint (if any) is
// dropped first; enum values live in a CHECK on the text column.
export class Migration20260727000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "delivery_order" drop constraint if exists "delivery_order_status_check";`,
    );
    this.addSql(
      `update "delivery_order" set "status" = 'processed' where "status" = 'packing';`,
    );
    this.addSql(
      `update "delivery_order" set "status" = 'completed' where "status" = 'delivered';`,
    );
    this.addSql(
      `alter table if exists "delivery_order" add constraint "delivery_order_status_check" check ("status" in ('requested','processed','ready_to_ship','shipped','completed','canceled'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "delivery_order" drop constraint if exists "delivery_order_status_check";`,
    );
    this.addSql(
      `update "delivery_order" set "status" = 'packing' where "status" = 'processed';`,
    );
    this.addSql(
      `update "delivery_order" set "status" = 'shipped' where "status" = 'ready_to_ship';`,
    );
    this.addSql(
      `update "delivery_order" set "status" = 'delivered' where "status" = 'completed';`,
    );
    this.addSql(
      `alter table if exists "delivery_order" add constraint "delivery_order_status_check" check ("status" in ('requested','packing','shipped','delivered','canceled'));`,
    );
  }
}
