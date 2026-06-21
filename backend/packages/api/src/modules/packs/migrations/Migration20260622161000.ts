import { Migration } from "@medusajs/framework/mikro-orm/migrations";

// Phase 2a — commission idempotency anchor. A retried open must never double-pay
// a beneficiary: at most ONE positive direct_referral/team_override row per
// (open, beneficiary, generation). Partial (positive commission credits only) so
// a later commission_reversal row can coexist with its original.
//
// Hand-written because db:generate cannot produce a partial-unique expression index.
// Runs AFTER Migration20260622160000 (timestamp 161000 > 160000) so the
// `generation` column on credit_transaction and the `commission` table already exist.
//
// NOTE on CONCURRENTLY: Medusa runs migrations inside a wrapping transaction, so
// CREATE UNIQUE INDEX CONCURRENTLY would error (CONCURRENTLY is forbidden in a txn).
// The plain form is safe here because commission rows start on an EMPTY data set —
// no online-build hazard.
export class Migration20260622161000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create unique index if not exists "IDX_credit_transaction_commission_idem" ` +
        `on "credit_transaction" ("source_transaction_id", "reason", "customer_id", "generation") ` +
        `where amount > 0 and reason in ('direct_referral', 'team_override') and deleted_at is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "IDX_credit_transaction_commission_idem";`,
    );
  }
}
