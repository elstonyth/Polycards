import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// challenge_payout — the settled-week record (weekly challenge auto-payout,
// spec 2026-07-29). Purely additive: one table, two partial indexes.
//
// SQL below is VERBATIM from `medusa db:generate packs` (bigNumber `credits`
// ships with its `raw_credits` jsonb twin — the trap a hand-written migration
// falls into). The generate also re-emitted ~110 lines of stale-snapshot
// drift (tables/columns from earlier HAND-WRITTEN migrations that never
// updated .snapshot-packs.json — ledger_entry, purchase_invoice, etc.);
// every one was verified already covered by a committed migration and
// trimmed here, because the generated down() would have dropped nine live
// tables. The refreshed .snapshot-packs.json is committed alongside, so the
// next generate starts from a truthful baseline.
export class Migration20260729070328 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "challenge_payout" ("id" text not null, "week_start" timestamptz not null, "customer_id" text not null, "rank" integer not null, "kind" text check ("kind" in ('credits', 'card')) not null, "card_id" text not null default '', "credits" numeric not null default 0, "credit_transaction_id" text null, "pull_id" text null, "status" text check ("status" in ('granted', 'skipped_no_stock')) not null default 'granted', "snapshot" jsonb not null, "raw_credits" jsonb not null default '{"value":"0","precision":20}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "challenge_payout_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_challenge_payout_deleted_at" ON "challenge_payout" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_challenge_payout_week_customer_kind_card" ON "challenge_payout" ("week_start", "customer_id", "kind", "card_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_challenge_payout_week" ON "challenge_payout" ("week_start") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "challenge_payout" cascade;`);
  }
}
