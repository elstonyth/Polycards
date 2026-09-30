import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Per-pack pull reads (store/pulls/recent?pack_id, pullDrought(packId)) had no
// index of their own and walked IDX_pull_rolled_at across every pack, or
// seq-scanned: two days into launch `pull` had taken ~20k sequential scans.
// Declared on the Pull model as well. Hand-written, like the other index
// migrations here: `db:generate` against the current snapshot also re-emits
// unrelated, already-applied changes.
//
// Plain CREATE INDEX (not CONCURRENTLY): the migrate job runs in a transaction
// and the table is small (~6k rows on 2026-09-30), so the lock is brief.
export class Migration20260930120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pull_pack_id_rolled_at" ON "pull" ("pack_id", "rolled_at") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "IDX_pull_pack_id_rolled_at";`);
  }
}
