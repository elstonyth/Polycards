import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Serves setRealName's lookup of a name on another account (ADR 0015). Not unique,
// because names already on file repeat. Not in the model or snapshot: the DML can't
// declare an expression index, same as the customer handle index in
// Migration20260930140000. The expression must match realNameKeySql, which a unit
// spec pins, or the lookup silently scans again.
export class Migration20261103190000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create index if not exists "IDX_customer_account_state_real_name_key" on "customer_account_state" (lower(regexp_replace(real_name, '[ .''@/,-]', '', 'g'))) where real_name is not null and deleted_at is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "IDX_customer_account_state_real_name_key";`,
    );
  }
}
