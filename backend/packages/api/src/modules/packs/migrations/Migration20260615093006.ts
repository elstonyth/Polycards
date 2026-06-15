import { Migration } from "@mikro-orm/migrations";

// Adds five partial (WHERE deleted_at IS NULL) indexes on the packs-module hot
// read columns: the per-customer balance / vault / profile reads, the global
// recent-pulls feed + leaderboard window, and the per-pack gacha build +
// per-card rarity joins. Index-only — no table or column changes.
export class Migration20260615093006 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_credit_transaction_customer_id_created_at" ON "credit_transaction" ("customer_id", "created_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pull_customer_id_rolled_at" ON "pull" ("customer_id", "rolled_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pull_rolled_at" ON "pull" ("rolled_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pack_odds_pack_id" ON "pack_odds" ("pack_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pack_odds_card_id" ON "pack_odds" ("card_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "IDX_credit_transaction_customer_id_created_at";`);
    this.addSql(`DROP INDEX IF EXISTS "IDX_pull_customer_id_rolled_at";`);
    this.addSql(`DROP INDEX IF EXISTS "IDX_pull_rolled_at";`);
    this.addSql(`DROP INDEX IF EXISTS "IDX_pack_odds_pack_id";`);
    this.addSql(`DROP INDEX IF EXISTS "IDX_pack_odds_card_id";`);
  }
}
