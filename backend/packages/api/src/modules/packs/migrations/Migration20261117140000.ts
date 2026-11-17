import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Why a held withdrawal waits (ADR 0018): 'amount' over the approval
// threshold, or 'shared_device' when an earlier account shares the browser.
// Nullable: rows held before this, and every row not held, carry none. Old
// code never writes it, so the usual migrate-then-serve order holds. NOT VALID:
// existing rows are all NULL, so no full-table check under the exclusive lock.
export class Migration20261117140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql('alter table "gateway_withdrawal" add column if not exists "hold_reason" text null;');
    this.addSql('alter table "gateway_withdrawal" drop constraint if exists "gateway_withdrawal_hold_reason_check";');
    this.addSql(`alter table "gateway_withdrawal" add constraint "gateway_withdrawal_hold_reason_check" check ("hold_reason" is null or "hold_reason" in ('amount', 'shared_device')) not valid;`);
  }

  override async down(): Promise<void> {
    this.addSql('alter table "gateway_withdrawal" drop constraint if exists "gateway_withdrawal_hold_reason_check";');
    this.addSql('alter table "gateway_withdrawal" drop column if exists "hold_reason";');
  }
}
