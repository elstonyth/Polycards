import { Migration } from "@medusajs/framework/mikro-orm/migrations";

// Phase 2a — adds the open-id anchor to the credit ledger. Additive + nullable =
// online-safe on the live money table (no rewrite, no lock beyond the brief
// catalog update). Holds the pack_open charge's open_id and, later, every
// commission row's source open id (the idempotency key, Task 12).
export class Migration20260622120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "credit_transaction" add column if not exists "source_transaction_id" text null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "credit_transaction" drop column if exists "source_transaction_id" cascade;`,
    );
  }
}
