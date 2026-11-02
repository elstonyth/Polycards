import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Checks Migration20261031100000 added NOT VALID. Validating scans each table but
// lets reads and writes carry on, so it runs apart from the ALTERs that do not.
const CHECKS = [
  ['pull', 'pull_status_check'],
  ['credit_transaction', 'credit_transaction_reason_check'],
  ['credit_transaction', 'credit_coin_flip_basis_check'],
  ['ledger_entry', 'ledger_entry_type_check'],
  ['admin_action_audit', 'admin_action_audit_entity_type_check'],
];

export class Migration20261031100400 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    for (const [table, check] of CHECKS) {
      this.addSql(`alter table "${table}" validate constraint "${check}";`);
    }
  }

  // Nothing to undo: a validated check is the same check.
  override async down(): Promise<void> {}
}
