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
    // EXPAND phase (see .do/README.md): the PRE_DEPLOY migrate job runs while
    // the OLD containers still serve, and a rollback runs OLD code against this
    // schema. So the re-added CHECK accepts the UNION of both vocabularies —
    // narrowing it here would 500 every old-code write of 'packing'/'delivered'.
    // The row rewrites above still move existing data to the new names.
    // TODO(POLYCARD-BACK §1.2, next release): CONTRACT — once no old container
    // can be rolled back to, add Migration<next>_delivery_status_contract that
    // drops this constraint and re-adds it with the 6-value set matching
    // models/delivery-order.ts `model.enum([...])`. `medusa db:generate` can
    // author it: .snapshot-packs.json still lists the pre-rename 5 values, so
    // it has a real diff to emit (review the output — it will also want to
    // repeat this migration's row rewrites, which by then are no-ops).
    this.addSql(
      `alter table if exists "delivery_order" add constraint "delivery_order_status_check" check ("status" in ('requested','packing','processed','ready_to_ship','shipped','delivered','completed','canceled'));`,
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
