import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Epic 4 closing migration: the index that serves the DEFAULT Transactions tab.
//
// Migration20260728210000 indexed (customer_id, occurred_at) and
// (type, occurred_at), so every FILTERED admin query is covered — but the
// unfiltered `deleted_at IS NULL ORDER BY occurred_at DESC` (page 1 of the All
// tab, the most common admin action) had no leading-column match and fell back
// to a seq scan + top-N sort on an append-only table.
//
// Shipped now rather than "when it matters": a non-concurrent CREATE INDEX
// takes ACCESS EXCLUSIVE, which is free on today's near-empty table but would
// block the pack-open write path once the table has volume.
//
// The list's full sort key is (occurred_at DESC, id DESC); this single-column
// index supplies the leading key and Postgres resolves the `id` tiebreak with
// an incremental sort, so no full sort of the table remains.
export class Migration20260728211500 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ledger_entry_occurred_at" ON "ledger_entry" ("occurred_at" DESC) WHERE "deleted_at" IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "IDX_ledger_entry_occurred_at";`);
  }
}
