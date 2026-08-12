import { Migration } from '@mikro-orm/migrations';

// Adds customer_account_state.disabled_cause, which splits an admin disable
// (the §4.2 support lever) from a customer's own reversible self-disable.
//
// The backfill is the security-relevant half: every disable that exists today
// was made by an admin, and a NULL cause reaching the login guard would look
// like "not an admin disable" to a naive `cause === 'admin'` test. The guards
// are written to fail closed regardless (they test `cause === 'self'`), but a
// correct backfill means that fallback never has to carry a live account.
export class Migration20260813100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_account_state" add column if not exists "disabled_cause" text null;`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" drop constraint if exists "customer_account_state_disabled_cause_check";`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" add constraint "customer_account_state_disabled_cause_check" check ("disabled_cause" in ('admin','self'));`,
    );
    this.addSql(
      `update "customer_account_state" set "disabled_cause" = 'admin' where "disabled" = true and "disabled_cause" is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_account_state" drop constraint if exists "customer_account_state_disabled_cause_check";`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" drop column if exists "disabled_cause";`,
    );
  }
}
