import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Admins can give (or take back) Lucky Draw tickets, one customer or a whole
// customer group at a time (operator 2026-10-25), so the ticket ledger's
// reason CHECK gains 'admin_grant'. Hand-written; no table or column change.
// Old code never writes the new value, so DEPLOY ORDER is the usual
// migrate-then-serve. Idempotent: the CHECK is dropped and re-added whole.
export class Migration20261025120000 extends Migration {
  override async up(): Promise<void> {
    this.reasons(['task_claim', 'entry', 'refund', 'admin_grant']);
  }

  override async down(): Promise<void> {
    // Narrowing the CHECK fails against rows that use the new value: refuse
    // while any exists.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM lucky_draw_ticket WHERE reason = 'admin_grant')
        THEN
          RAISE EXCEPTION 'admin_grant ticket rows exist; refusing to unwind Migration20261025120000';
        END IF;
      END $$;`);
    this.reasons(['task_claim', 'entry', 'refund']);
  }

  private reasons(values: string[]): void {
    this.addSql(
      `alter table if exists "lucky_draw_ticket" drop constraint if exists "lucky_draw_ticket_reason_check";`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_ticket" add constraint "lucky_draw_ticket_reason_check" check ("reason" in (${values.map((v) => `'${v}'`).join(', ')}));`,
    );
  }
}
