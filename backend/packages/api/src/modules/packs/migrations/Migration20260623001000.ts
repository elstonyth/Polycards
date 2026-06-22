import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Phase 3a hardening — unbypassable guards (timestamp > 161000 so the tables exist).
//   1. referral_relationship: a recruit can never be their own sponsor (was
//      service-enforced only in linkSponsor).
//   2. credit_transaction: at most ONE reversal row per source row, so reversal
//      idempotency no longer depends on every caller agreeing on a lock key.
//      Plain (not CONCURRENTLY) — Medusa wraps migrations in a txn. Existing rows
//      are clean by construction (reverseOpen/reverseCreditTransaction skip if a
//      reversal:<id> already exists), so the unique build cannot collide.
export class Migration20260623001000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "referral_relationship" drop constraint if exists "referral_relationship_no_self_referral";`);
    this.addSql(`alter table if exists "referral_relationship" add constraint "referral_relationship_no_self_referral" check ("customer_id" <> "sponsor_id");`);

    this.addSql(`create unique index if not exists "IDX_credit_transaction_reversal_reference" on "credit_transaction" ("reference") where reference like 'reversal:%' and deleted_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_credit_transaction_reversal_reference";`);
    this.addSql(`alter table if exists "referral_relationship" drop constraint if exists "referral_relationship_no_self_referral";`);
  }
}
