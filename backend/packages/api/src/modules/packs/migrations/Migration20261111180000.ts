import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Two read indexes from the 2026-11-11 backend audit's LOW list. Declared on
// the Pull and CoinFlipRound models too, and the SQL below is what db:generate
// emits for those declarations. Hand-written, like the other index migrations.
//
// 1. IDX_pull_open_id: the hourly unfinished-open sweep (unfinishedMoneyRows),
//    refundUnfinishedOpen and UNOPENED_GIFT_SQL all filter pull on open_id,
//    and nothing indexed it, so each one scanned pull. Every reader also says
//    `deleted_at IS NULL` and compares with `=`, so the partial index applies.
// 2. IDX_coin_flip_round_settled: GET /store/coin-flips/recent (polled every
//    few seconds) and the per-customer history order settled rounds by
//    settled_at, which only a sort over every settled round answered.
//
// Plain CREATE INDEX (not CONCURRENTLY): the migrate job runs in a
// transaction. pull is the larger table; its build holds a write lock on pull
// for its duration (credit_transaction's two indexes on 212k rows took 0.14 s).
export class Migration20261111180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pull_open_id" ON "pull" ("open_id") WHERE open_id IS NOT NULL AND deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_coin_flip_round_settled" ON "coin_flip_round" ("settled_at", "id") WHERE status IN ('won', 'lost') AND deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "IDX_pull_open_id";`);
    this.addSql(`DROP INDEX IF EXISTS "IDX_coin_flip_round_settled";`);
  }
}
