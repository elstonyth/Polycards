import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// A capsule's history (store/pulls/recent and gaps with ?pack_id) reads
// ticket_spin by pack on every feed rebuild, the read that made `pull` take ~20k
// sequential scans in two days before Migration20260930120000. Declared on the
// TicketSpin model as well. Hand-written, like the other index migrations here.
//
// Plain CREATE INDEX (not CONCURRENTLY): the migrate job runs in a transaction
// and the table is days old, so the lock is brief.
export class Migration20261102100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ticket_spin_pack_id_rolled_at" ON "ticket_spin" ("pack_id", "rolled_at") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "IDX_ticket_spin_pack_id_rolled_at";`);
  }
}
