import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Task A2 — cross-column payout CHECK for pack_odds reward entries.
// db:generate emitted the additive cols + DROP NOT NULL (Migration20260624212744).
// This migration adds ONLY the cross-column consistency CHECK that db:generate
// cannot emit. Order matters: nullability must be relaxed first (done above).
//
// Legacy card rows pass via the "kind IS NULL AND card_id IS NOT NULL" branch.
// No backfill — existing rows keep kind=NULL.
export class Migration20260625052600 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "pack_odds" ADD CONSTRAINT "pack_odds_kind_payout_check" CHECK (
        (kind = 'product' AND product_handle IS NOT NULL AND credit_amount IS NULL AND card_id IS NULL)
        OR (kind = 'credit'  AND credit_amount > 0 AND product_handle IS NULL AND card_id IS NULL)
        OR (kind = 'nothing' AND product_handle IS NULL AND credit_amount IS NULL AND card_id IS NULL)
        OR (kind IS NULL AND card_id IS NOT NULL AND product_handle IS NULL AND credit_amount IS NULL)
      );`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE "pack_odds" DROP CONSTRAINT IF EXISTS "pack_odds_kind_payout_check";`,
    );
    // Leave nullability relaxed — reverting to NOT NULL would break reward rows.
  }
}
