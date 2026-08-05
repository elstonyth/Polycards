import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Vouchers off across the whole VIP ladder (operator decision, 2026-08-05).
//
// The ladder paid a voucher on level-up — RM 1,500 through the 90s, 12,000 at
// L90, 15,000 at L100 — while the surface that redeems them has been suspended
// since #294. Every level-up was minting a grant nobody could spend. The admin
// stopped showing the field in #371, which left no way to turn it off from the
// UI either, so it is turned off here.
//
// The mechanism stays: rewardsForLevel only emits a voucher when the amount is
// > 0 (vip-rewards.ts), so zeroed rows simply grant nothing. Re-pricing a rung
// is a one-row UPDATE if the surface ever comes back.
//
// This also unblocks the Levels tab. validateVipLevels caps voucher_amount at
// MAX_VOUCHER_MYR (10,000) and rejects the WHOLE ladder on one bad rung, so
// L90/L100 have made every VIP-ladder save fail since #247 — a threshold edit
// at L5 rejected because of L100's voucher.
//
// voucher_amount is a bigNumber: the numeric column AND its raw_ jsonb sidecar
// have to move together, or the ORM keeps reading the old amount back out of
// raw_voucher_amount and nothing changes. Same shape as Migration20260615094216.
export class Migration20260805000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`UPDATE "vip_level"
      SET "voucher_amount" = 0,
          "raw_voucher_amount" = jsonb_build_object('value', '0', 'precision', 20),
          "updated_at" = now()
      WHERE "deleted_at" IS NULL
        AND ("voucher_amount" <> 0 OR "raw_voucher_amount"->>'value' <> '0');`);
  }

  override async down(): Promise<void> {
    // Deliberately empty. The per-level amounts this cleared were operator
    // config, not derivable from anything left in the database — a down() that
    // wrote the Workbook1.xlsx figures back would invent numbers the operator
    // may have since changed (prod ran 1,500 through the 90s; the workbook does
    // not). The workbook and scripts/vip-levels.data.ts keep the originals on
    // paper; restoring them is a deliberate re-price, not a rollback.
  }
}
