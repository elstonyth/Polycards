import { Migration } from "@medusajs/framework/mikro-orm/migrations";

// Adds Pull.revealed_at — the reveal-anchored start of the 30s instant-sell
// window (see buyback-rate.ts). Additive + nullable: existing pulls are NULL,
// for which the rate resolver falls back to rolled_at + window.
export class Migration20260616000010 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "pull" ADD COLUMN IF NOT EXISTS "revealed_at" timestamptz NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`ALTER TABLE "pull" DROP COLUMN IF EXISTS "revealed_at";`);
  }
}
