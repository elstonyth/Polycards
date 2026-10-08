import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Relabel pulls written under the first bonus-credit rule (spec 2026-10-07,
// review 2026-10-08). That rule called a paid pull 'bonus' when ANY bonus paid
// for it, so a few ringgit of leftover bonus made a real-money open count
// toward nothing. A paid pull is now 'bonus' only when bonus paid at least
// half of it (bonus_bp >= 5000, paidPullSource). bonus_bp is untouched: the
// sell-back still pays its bonus share as bonus, so no value moves.
//
// Data only, idempotent; a no-op where nothing was written under the old rule.
export class Migration20261008100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `update "pull" set "source" = 'pack' where "source" = 'bonus' and "bonus_bp" < 5000;`,
    );
  }

  // Nothing to undo: the old rule's labels are not worth restoring, and the
  // previous code reads 'pack' rows correctly.
  override async down(): Promise<void> {}
}
