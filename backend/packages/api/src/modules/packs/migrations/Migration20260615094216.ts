import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260615094216 extends Migration {

  override async up(): Promise<void> {
    // int -> numeric so prices can hold cents (forward-compat; current data is
    // clean whole dollars). Ordered: retype, add nullable sidecar, backfill the
    // existing rows, then enforce NOT NULL. bigNumber stores value + precision
    // (matches the live raw_amount shape: {"value":"25","precision":20}).
    this.addSql(`ALTER TABLE "pack" ALTER COLUMN "price" TYPE numeric USING ("price"::numeric);`);
    this.addSql(`ALTER TABLE "pack" ADD COLUMN IF NOT EXISTS "raw_price" jsonb;`);
    this.addSql(`UPDATE "pack" SET "raw_price" = jsonb_build_object('value', "price"::text, 'precision', 20) WHERE "raw_price" IS NULL;`);
    this.addSql(`ALTER TABLE "pack" ALTER COLUMN "raw_price" SET NOT NULL;`);
  }

  override async down(): Promise<void> {
    // Lossy by nature: integer truncates any cents written while decimal.
    this.addSql(`ALTER TABLE "pack" DROP COLUMN IF EXISTS "raw_price";`);
    this.addSql(`ALTER TABLE "pack" ALTER COLUMN "price" TYPE integer USING (round("price")::integer);`);
  }

}
