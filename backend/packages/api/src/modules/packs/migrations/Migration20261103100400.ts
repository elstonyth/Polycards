import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Checks Migration20261103100000 added NOT VALID. The migrator runs all pending
// migrations in one transaction, so on a deploy that applies both the ALTERs' lock
// stays held through these scans: 165 ms on a copy of production data, 2026-11-03.
const CHECKS = [
  ['pull', 'pull_status_check'],
  ['credit_transaction', 'credit_transaction_reason_check'],
  ['credit_transaction', 'credit_coin_flip_basis_check'],
  ['ledger_entry', 'ledger_entry_type_check'],
  ['admin_action_audit', 'admin_action_audit_entity_type_check'],
];

export class Migration20261103100400 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    for (const [table, check] of CHECKS) {
      this.addSql(`alter table "${table}" validate constraint "${check}";`);
    }
  }

  // Nothing to undo: a validated check is the same check.
  override async down(): Promise<void> {}
}
