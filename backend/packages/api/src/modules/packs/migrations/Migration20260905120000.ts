import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Gateway audit columns (plan 130). The audit sweep re-reads FINAL rows
// against the gateway and records when it looked and what it disagreed about;
// a NULL note is "the gateway agrees". Both nullable, no backfill: every
// existing row simply reads as "not audited yet".
export class Migration20260905120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table if exists "globepay_deposit"
        add column if not exists "audited_at" timestamptz null,
        add column if not exists "audit_note" text null;
    `);
    this.addSql(`
      alter table if exists "globepay_withdrawal"
        add column if not exists "audited_at" timestamptz null,
        add column if not exists "audit_note" text null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table if exists "globepay_deposit"
        drop column if exists "audited_at",
        drop column if exists "audit_note";
    `);
    this.addSql(`
      alter table if exists "globepay_withdrawal"
        drop column if exists "audited_at",
        drop column if exists "audit_note";
    `);
  }
}
