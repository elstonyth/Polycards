import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Rename the `Epic` tier to `Mythical` (same slot: Immortal > Legendary >
// Mythical > Rare > Uncommon > Common). The column is text + CHECK, so the
// rename = swap the constraint AND migrate existing rows between drop/add —
// adding the new CHECK with 'Epic' rows still present would fail validation.
export class Migration20260703165559 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "pack_odds" drop constraint if exists "pack_odds_rarity_check";`,
    );

    this.addSql(
      `update "pack_odds" set "rarity" = 'Mythical' where "rarity" = 'Epic';`,
    );

    this.addSql(
      `alter table if exists "pack_odds" add constraint "pack_odds_rarity_check" check("rarity" in ('Immortal', 'Legendary', 'Mythical', 'Rare', 'Uncommon', 'Common'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "pack_odds" drop constraint if exists "pack_odds_rarity_check";`,
    );

    this.addSql(
      `update "pack_odds" set "rarity" = 'Epic' where "rarity" = 'Mythical';`,
    );

    this.addSql(
      `alter table if exists "pack_odds" add constraint "pack_odds_rarity_check" check("rarity" in ('Immortal', 'Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'));`,
    );
  }
}
