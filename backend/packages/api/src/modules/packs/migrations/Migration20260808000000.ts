import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Odds precision ×100: weights move from basis points (Σ = 10,000 per pack;
// 1 unit = 0.01%) to fine units (Σ = 1,000,000; 1 unit = 0.0001%) so the
// odds editor can manage 4-decimal win rates exactly (@acme/odds-math
// TOTAL_UNITS / PCT_SCALE).
//
// The draw itself is scale-invariant — secureRoll(totalWeight) rolls in
// [0, Σweight) and pickWonRow walks cumulative weights — so rows are
// consistent both before and after this UPDATE; only the pct readouts
// (weight / PCT_SCALE) and the fixed-bound reward-box roll assume the new
// scale, and both ship in the same deploy as this migration.
//
// weight_2/weight_3 are sparse (NULL = inherit); NULL * 100 stays NULL, so
// inheritance is preserved verbatim.
export class Migration20260808000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'update "pack_odds" set "weight" = "weight" * 100, "weight_2" = "weight_2" * 100, "weight_3" = "weight_3" * 100;',
    );
    this.addSql('update "reward_box_prize" set "weight" = "weight" * 100;');
  }

  override async down(): Promise<void> {
    this.addSql(
      'update "pack_odds" set "weight" = round("weight" / 100.0), "weight_2" = round("weight_2" / 100.0), "weight_3" = round("weight_3" / 100.0);',
    );
    this.addSql(
      'update "reward_box_prize" set "weight" = round("weight" / 100.0);',
    );
  }
}
