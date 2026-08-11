import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// globepay_withdrawal.status gains 'held' (plan 094 — hold payouts above the
// admin-approval threshold instead of auto-submitting them to the gateway).
//
// 'held' means: debited, awaiting admin approval, never submitted to the
// gateway. It has no gateway_transaction_id and the reconcile sweep must
// never select it (see models/globepay-withdrawal.ts). It leaves only via
// the admin approve route (-> 'pending') or the admin deny route (->
// 'failed', refunded). This migration only widens the constraint — no code
// path writes 'held' yet; that lands in a later plan-094 task.
//
// LOCKING — same shape as the sibling globepay_deposit widening
// (Migration20260807120000), because this is also a live money table:
//   - The new constraint is a strict WIDENING (every existing row already
//     satisfies it), so `not valid` is sound: it skips the full-table
//     validation scan and takes only a brief catalog-level ACCESS EXCLUSIVE
//     lock, never a scan-length one.
//   - `validate constraint` then promotes it under SHARE UPDATE EXCLUSIVE,
//     which does not block concurrent reads or writes.
//
// The constraint's name is looked up from information_schema rather than
// assumed: Postgres, not this migration, chose it when the table was first
// created (Migration20260722170000), by auto-naming an unnamed column CHECK.
export class Migration20260811220000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      DO $$
      DECLARE
        v_constraint_name text;
      BEGIN
        SELECT tc.constraint_name INTO v_constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
         AND tc.constraint_schema = ccu.constraint_schema
        WHERE tc.table_name = 'globepay_withdrawal'
          AND ccu.column_name = 'status'
          AND tc.constraint_type = 'CHECK';

        IF v_constraint_name IS NOT NULL THEN
          EXECUTE format('alter table "globepay_withdrawal" drop constraint %I', v_constraint_name);
        END IF;
      END $$;
    `);
    this.addSql(
      `alter table if exists "globepay_withdrawal" add constraint "globepay_withdrawal_status_check" check ("status" in ('pending', 'settled', 'failed', 'held')) not valid;`,
    );
    this.addSql(
      `alter table if exists "globepay_withdrawal" validate constraint "globepay_withdrawal_status_check";`,
    );
  }

  override async down(): Promise<void> {
    // Plain restore, no data migration: nothing writes 'held' until a later
    // plan-094 task, so no row can hold it yet. If a future rollback runs
    // after that task ships and 'held' rows exist, this fails loud (Postgres
    // validates the narrowed CHECK against existing data) rather than
    // guessing which terminal state to move them to — that choice belongs to
    // whichever task adds the un-hold paths, not to this one.
    this.addSql(
      `alter table if exists "globepay_withdrawal" drop constraint if exists "globepay_withdrawal_status_check";`,
    );
    this.addSql(
      `alter table if exists "globepay_withdrawal" add constraint "globepay_withdrawal_status_check" check ("status" in ('pending', 'settled', 'failed'));`,
    );
  }
}
