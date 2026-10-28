import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// The gateway audit no longer treats an expired top-up that the gateway still
// shows as pending as a disagreement (gateway-audit.ts): the customer never
// paid, and the gateway does not close abandoned orders. Rows audited before
// the change keep that note, and rows older than the audit's 7-day window are
// never re-read, so the stored notes would hold the "payments differ" count
// up forever. Clear exactly that note on expired rows; every other finding
// stays. On 2026-10-14 it was about 430 of 432 notes.
export class Migration20261014120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`update "gateway_deposit" set "audit_note" = null
      where "status" = 'expired'
        and "audit_note" = 'gateway still reports pending for a row we marked expired';`);
  }

  // Nothing to restore: the note no longer counts as a finding.
  override async down(): Promise<void> {}
}
