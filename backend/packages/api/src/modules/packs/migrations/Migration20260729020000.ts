import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// purchase_invoice_line.line_total must actually BE the product it claims to
// be (Epic 5 Task 1 review carry-over). Production D8 cost math reads `qty`
// and `unit_cost`, so drift here can never corrupt the cost column — but it
// does corrupt every displayed invoice total, and on a reversal line a
// sign-flipped total is exactly the shape of a silently-wrong credit note.
//
// Deliberately a HALF-SEN TOLERANCE, not `line_total = qty * unit_cost`.
// Verified against this DB that Medusa's BigNumber writes JS float products
// verbatim — `3 * 0.07` stores as 0.21000000000000002, not 0.21 — while
// Postgres numeric arithmetic evaluates `qty * unit_cost` to exactly 0.21.
// Strict equality therefore REJECTS a legitimate 2dp line. Task 3's validator
// caps unit_cost at "finite and >= 0" with no decimal-place limit, so this is
// a live insert path, not a hypothetical. Money is 2dp; "agrees to within
// half a sen" is the strongest statement true of every valid line, and it
// still rejects real drift (a wrong total, or a positive total on a
// negative-qty reversal line) by orders of magnitude.
//
// Free to add now — purchase_invoice_line is empty. Once data exists this
// needs ADD CONSTRAINT ... NOT VALID followed by a backfill VALIDATE.
//
// Name check: 20260729000000 is feat/odds-autosplit and 20260729010000 is
// Epic 5 Task 1 — BOTH already applied to the shared dev DB. MikroORM keys
// applied migrations by NAME, so a reused name silently never runs. This name
// was verified free in every git ref AND in mikro_orm_migrations before use.
export class Migration20260729020000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "purchase_invoice_line" drop constraint if exists "purchase_invoice_line_line_total_check";`,
    );
    this.addSql(
      `alter table if exists "purchase_invoice_line" add constraint "purchase_invoice_line_line_total_check" check (abs("line_total" - "qty" * "unit_cost") < 0.005);`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "purchase_invoice_line" drop constraint if exists "purchase_invoice_line_line_total_check";`,
    );
  }
}
