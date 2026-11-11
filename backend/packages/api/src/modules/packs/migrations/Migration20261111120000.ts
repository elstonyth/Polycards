import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Two credit_transaction indexes from the 2026-11-11 backend audit. Declared
// on the CreditTransaction model as well. Hand-written, like the other index
// migrations here.
//
// 1. UQ_credit_txn_keyed_once: top-ups, cashouts, task and challenge prizes,
//    adjustments and bonus grants are deduped only by the per-customer
//    `credit:` lock plus a SELECT on (customer_id, source_transaction_id). A
//    future writer that skipped mutateCreditAtomic would pay twice; now the
//    database refuses. Scoped to those five reasons on purpose: pack_open
//    reversals copy the debit's open id (UQ_credit_txn_pack_open_debit_open_id
//    covers the debit), and coin_flip_win has IDX_credit_coin_flip_round. The
//    11-02 prod copy had no duplicate in any reason.
// 2. IDX_credit_transaction_source_transaction_id: reverseOpen reads every row
//    of an open by source_transaction_id alone, under customer locks, and no
//    index led with it, so each compensation scanned the ledger, worst during
//    a failure storm.
//
// Plain CREATE INDEX (not CONCURRENTLY): the migrate job runs in a
// transaction. Timed on a copy of prod (212k rows): see the PR.
export class Migration20261111120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_credit_txn_keyed_once" ON "credit_transaction" ("customer_id", "source_transaction_id") WHERE reason IN ('topup', 'cashout', 'reward_credit', 'adjustment', 'bonus_grant') AND source_transaction_id IS NOT NULL AND deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_credit_transaction_source_transaction_id" ON "credit_transaction" ("source_transaction_id") WHERE source_transaction_id IS NOT NULL AND deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "UQ_credit_txn_keyed_once";`);
    this.addSql(
      `DROP INDEX IF EXISTS "IDX_credit_transaction_source_transaction_id";`,
    );
  }
}
