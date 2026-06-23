import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Phase 3b — no-sponsor debit idempotency. A replayed open_id must never
// double-debit even when no commission row exists to trip the commission index.
// Partial (original debits only: amount<0) so reverseOpen's POSITIVE reversal
// pack_open row (same source_transaction_id, reference 'reversal:%') coexists.
// Hand-written: db:generate cannot emit a partial-expression index.
export class Migration20260623100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create unique index if not exists "UQ_credit_txn_pack_open_debit_open_id" ` +
        `on "credit_transaction" ("source_transaction_id") ` +
        `where reason = 'pack_open' and amount < 0 and deleted_at is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "UQ_credit_txn_pack_open_debit_open_id";`,
    );
  }
}
