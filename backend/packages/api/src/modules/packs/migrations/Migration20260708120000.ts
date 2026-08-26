import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// RETIRED — the body is intentionally empty. The class stays so the name it
// already occupies in `mikro_orm_migrations` remains valid; deleting the file
// would leave production with a ledger row no migration answers to.
//
// What it used to do: restore `product_option.product_id` from the
// `product_product_option` pivot. It was a 2.13.4 hotfix. The #93 deploy
// briefly ran Medusa 2.17.2, whose core Migration20251022153442 dropped that
// column and moved the product<->option relation onto the pivots; #102 reverted
// the CODE to 2.13.4 but `db:migrate` only rolls forward, so 2.13.4's
// ProductOption — which still did belongsTo(Product) via `product_id`, and has
// `*options` in the DEFAULT admin product field set — 400'd on every product
// detail read. Re-adding the column reconciled schema with code.
//
// Why it is retired: the platform is on 2.19 and nothing reads
// `product_option.product_id` any more. On production this migration is already
// in the ledger and will never run again, but on every fresh local / CI / clone
// database it still ran — re-creating the exact 2.13.4 shape that
// Migration20260826120000 then has to undo, and that #503's
// `repair-product-option-pivots.cjs` had to repair on production. Emptying it
// stops new databases being born drifted.
//
// The reverse direction now lives in Migration20260826120000.down(), which
// rebuilds the column from the pivot the same way this once did.
export class Migration20260708120000 extends Migration {
  override async up(): Promise<void> {
    // Intentionally empty — see the note above.
  }

  override async down(): Promise<void> {
    // Intentionally empty — up() does nothing to reverse.
  }
}
