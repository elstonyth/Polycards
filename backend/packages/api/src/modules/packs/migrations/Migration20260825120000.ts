import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Remove the VIP daily box (operator decision 2026-08-25: the concept is dead).
// The engine, its admin authoring tab, its store routes and its storefront
// action half were deleted in the same change; this drops the schema behind
// them.
//
// What goes unconditionally — all of it pure CONFIG, none of it money history:
//   reward_box                  one row per VIP box tier (a–j, Z).
//   reward_box_prize            the authored prize table per box.
//   vip_level.box_tier          which box a rung opened.
//
// What is CONDITIONAL — reward_draw:
//   Each row is the record of one settled draw and may point at a real
//   credit_transaction (credit_txn_id) or a vaulted pull (vault_pull_id). That
//   is money history, and money history is not deleted to tidy up a retired
//   feature. So the table is dropped ONLY when it is empty. On a deployment
//   that has draws it is RETAINED, writerless and unmodelled, as a read-only
//   record; drop it deliberately later, after the operator has decided what to
//   do with those rows. This is why the guard raises no exception: a retained
//   table is a correct outcome here, not a failure, and failing the pre-deploy
//   migrate job over it would block an unrelated deploy.
//
// What deliberately STAYS:
//   vip_reward_grant.kind CHECK   still permits 'box', and grant.origin still
//                                 permits 'box'. Historical grant rows carry
//                                 those values; narrowing the CHECK against
//                                 existing rows would fail, and narrowing it
//                                 after deleting them would destroy a
//                                 customer's own reward history.
//   pack.category 'reward_box'    a different concept — internal draw pools in
//                                 the pack catalog, excluded from the
//                                 storefront listing and exempt from the RM0
//                                 price rule. Untouched here.
//
// down() recreates the three dropped tables/columns EMPTY. It restores schema,
// never data. box_tier comes back NULLABLE (it was NOT NULL) because there is
// no honest value to backfill onto existing rungs.
export class Migration20260825120000 extends Migration {
  override async up(): Promise<void> {
    // Config tables: no guard needed, nothing here is a money record.
    this.addSql(`drop table if exists "reward_box_prize" cascade;`);
    this.addSql(`drop table if exists "reward_box" cascade;`);
    this.addSql(
      `alter table if exists "vip_level" drop column if exists "box_tier";`,
    );

    // reward_draw: drop only when empty. RAISE NOTICE, never EXCEPTION — see
    // the header. Guard-recipe note: the RAISE branch here is the KEEP branch,
    // and it is the one that fires on any environment with draw history; the
    // drop branch is what fires on a clean one.
    this.addSql(`DO $$
      DECLARE
        n_draws bigint := 0;
      BEGIN
        IF to_regclass('public.reward_draw') IS NULL THEN
          RETURN;
        END IF;
        EXECUTE 'SELECT count(*) FROM reward_draw' INTO n_draws;
        IF n_draws = 0 THEN
          EXECUTE 'DROP TABLE reward_draw CASCADE';
        ELSE
          RAISE NOTICE
            'Keeping reward_draw: % row(s) of settled daily-box history remain, some of which may reference credit transactions or vaulted pulls. The table is now writerless; drop it deliberately once those rows have been dealt with.',
            n_draws;
        END IF;
      END $$;`);
  }

  override async down(): Promise<void> {
    this.addSql(
      `create table if not exists "reward_box" ("id" text not null, "tier" text not null, "name" text not null default '', "enabled" boolean not null default false, "draws_per_day" integer not null default 1, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "reward_box_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_reward_box_tier_unique" ON "reward_box" ("tier") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `create table if not exists "reward_box_prize" ("id" text not null, "box_id" text not null, "kind" text check ("kind" in ('credit', 'product', 'voucher', 'nothing')) not null, "payload" jsonb not null, "weight" integer not null, "locked" boolean not null default false, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "reward_box_prize_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_reward_box_prize_box" ON "reward_box_prize" ("box_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `create table if not exists "reward_draw" ("id" text not null, "customer_id" text not null, "tier" text not null, "draw_day" text not null, "draw_ordinal" integer not null, "prize_kind" text check ("prize_kind" in ('product', 'credit', 'voucher', 'nothing')) not null, "prize_snapshot" jsonb not null, "odds_snapshot" jsonb null, "vault_pull_id" text null, "credit_txn_id" text null, "status" text check ("status" in ('drawn', 'voided')) not null default 'drawn', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "reward_draw_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_reward_draw_customer_day" ON "reward_draw" ("customer_id", "draw_day") WHERE deleted_at IS NULL;`,
    );
    // NULLABLE on the way back: the column was NOT NULL, but there is no
    // honest tier to backfill onto rungs that have lived without one.
    this.addSql(
      `alter table if exists "vip_level" add column if not exists "box_tier" text null;`,
    );
  }
}
