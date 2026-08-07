import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// globepay_deposit.status gains 'expired'.
//
// WHY: the reconcile sweep wrote 'failed' for BOTH "the gateway said no" and
// "we stopped chasing a deposit it never ruled on", and it only ever scans
// 'pending'. So a deposit that timed out of the stale window was unreachable
// forever: a bank transfer landing afterwards credited nobody and nothing ever
// looked again. 'expired' keeps that row distinguishable and requeryable
// (jobs/globepay-reconcile.ts second scan tier), while 'failed' stays terminal.
//
// LOCKING — this is a live money table, so the shape is deliberate:
//   - The new constraint is a strict WIDENING (every existing row already
//     satisfies it), so `not valid` is sound: it skips the full-table
//     validation scan and takes only a brief catalog-level ACCESS EXCLUSIVE
//     lock, never a scan-length one.
//   - `validate constraint` then promotes it under SHARE UPDATE EXCLUSIVE,
//     which does not block concurrent reads or writes. Leaving the constraint
//     NOT VALID would work for new inserts but would confuse anyone reading
//     the schema later.
//
// The sibling globepay_withdrawal table carries an identical constraint and is
// deliberately NOT touched: "expiring" a withdrawal would confiscate a debit
// that already left the customer's balance (see globepay-reconcile.ts —
// WithdrawalReconcileAction has no 'expire' on purpose).
export class Migration20260807120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "globepay_deposit" drop constraint if exists "globepay_deposit_status_check";`,
    );
    this.addSql(
      `alter table if exists "globepay_deposit" add constraint "globepay_deposit_status_check" check ("status" in ('pending', 'settled', 'failed', 'expired')) not valid;`,
    );
    this.addSql(
      `alter table if exists "globepay_deposit" validate constraint "globepay_deposit_status_check";`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "globepay_deposit" drop constraint if exists "globepay_deposit_status_check";`,
    );
    // The narrowed constraint cannot represent 'expired', so those rows must
    // move first or the ADD below dies mid-rollback. They go back to 'pending',
    // NOT to 'failed': 'pending' is the only pre-change value that keeps the
    // sweep chasing them, and rolling a row that was never refused into a
    // terminal 'failed' would re-create the exact money-loss this migration
    // exists to end. Nothing is deleted — these rows are payment records.
    this.addSql(
      `update "globepay_deposit" set "status" = 'pending' where "status" = 'expired';`,
    );
    this.addSql(
      `alter table if exists "globepay_deposit" add constraint "globepay_deposit_status_check" check ("status" in ('pending', 'settled', 'failed'));`,
    );
  }
}
