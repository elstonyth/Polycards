import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Six soft-delete indexes the ORM auto-emits for every model but that no
// migration ever created: the HAND-WRITTEN migrations for these tables omitted
// them, so production lacks them. Now that Migration20260729070328 committed a
// refreshed .snapshot-packs.json asserting they exist, no future
// `medusa db:generate` will ever emit them again — this is the only chance.
//
// Purely additive and performance-only (no correctness impact): they back the
// `deleted_at IS NULL` predicate every generated list/retrieve appends.
// Hand-written is correct here — plain partial indexes, no bigNumber column
// involved, so none of the raw_* trap applies. IF NOT EXISTS keeps it a no-op
// on any database that already has them.
export class Migration20260729120010 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ledger_entry_deleted_at" ON "ledger_entry" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ledger_sequence_deleted_at" ON "ledger_sequence" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_player_payout_details_deleted_at" ON "player_payout_details" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_purchase_invoice_deleted_at" ON "purchase_invoice" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_purchase_invoice_line_deleted_at" ON "purchase_invoice_line" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_stock_movement_deleted_at" ON "stock_movement" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_ledger_entry_deleted_at";`);
    this.addSql(`drop index if exists "IDX_ledger_sequence_deleted_at";`);
    this.addSql(`drop index if exists "IDX_player_payout_details_deleted_at";`);
    this.addSql(`drop index if exists "IDX_purchase_invoice_deleted_at";`);
    this.addSql(`drop index if exists "IDX_purchase_invoice_line_deleted_at";`);
    this.addSql(`drop index if exists "IDX_stock_movement_deleted_at";`);
  }
}
