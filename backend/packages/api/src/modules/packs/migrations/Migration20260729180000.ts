import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Widen ledger_entry.type to accept 'WD' — a GlobePay365 payout.
//
// WHY: every balance move must have a ledger row (the conservation invariant in
// integration-tests/http/ledger-conservation.spec.ts: Σ(ledger) == balance).
// The withdrawal debit and its refunds moved the balance and wrote nothing,
// because no LedgerType represented money leaving by payout — 'WP' is the
// weekly challenge payout, 'RF' is period rakeback, 'AD' is an admin
// adjustment. Arming payouts without this would have broken conservation on the
// first withdrawal.
//
// EXPAND phase only, deliberately: the up() widens the CHECK, the down()
// narrows it back and would FAIL if any WD row exists — which is correct, since
// silently dropping the constraint would leave rows no longer covered by it.
// Hand-written (no bigNumber column involved, so the raw_* trap does not
// apply), and the .snapshot-packs.json enumItems are updated in the same commit
// so a later `medusa db:generate` does not re-emit this.
export class Migration20260729180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "ledger_entry" DROP CONSTRAINT IF EXISTS "ledger_entry_type_check";`,
    );
    this.addSql(
      `ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_type_check" CHECK ("type" IN ('TP','SP','SE','OD','RF','AD','WP','WD'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE "ledger_entry" DROP CONSTRAINT IF EXISTS "ledger_entry_type_check";`,
    );
    this.addSql(
      `ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_type_check" CHECK ("type" IN ('TP','SP','SE','OD','RF','AD','WP'));`,
    );
  }
}
