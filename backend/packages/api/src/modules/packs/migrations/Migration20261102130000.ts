import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// A category's history (store/pulls/recent with ?category) reads ticket_spin for
// several packs, newest first. IDX_ticket_spin_pack_id_rolled_at can't stop at the
// LIMIT over an IN list, so without this every 5s rebuild sorts all the category's
// spins. The same shape as IDX_pull_rolled_at. Declared on the TicketSpin model as
// well. Hand-written, like the other index migrations here.
//
// Plain CREATE INDEX (not CONCURRENTLY): the migrate job runs in a transaction
// and the table is days old, so the lock is brief.
export class Migration20261102130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ticket_spin_rolled_at" ON "ticket_spin" ("rolled_at") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "IDX_ticket_spin_rolled_at";`);
  }
}
