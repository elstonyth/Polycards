import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Remove the referral programme from the schema. The engine (sponsor tree,
// commission lifecycle, maturity job, admin surfaces) was deleted in the same
// change; this drops the tables and columns that backed it so a rebuilt
// referral system starts from a clean schema instead of inheriting this one's
// shape.
//
// What goes:
//   referral_relationship          the sponsor tree. Its only writer
//                                  (linkSponsor) was already removed, so no
//                                  row could be added after that change.
//   commission                     the 1:1 lifecycle record beside each
//                                  commission credit row.
//   credit_transaction.generation  commission-only (1 = direct sponsor, >1 =
//                                  override ancestor). NOT source_transaction_id
//                                  — that is also stamped on pack_open charges
//                                  and stays.
//   credit_transaction reasons     'direct_referral', 'team_override' and
//                                  'commission_reversal' leave the CHECK.
//   ledger_entry type 'RF'         the referral-payout ledger type. Writerless
//                                  since the epic was cancelled.
//   rewards_settings.*             commission_cooldown_days, team_override_pct
//                                  (+ its raw_ sidecar) and
//                                  override_generation_cap. Only
//                                  withdrawals_per_day survives.
//   vip_level.direct_referral_pct  the per-level commission rate.
//
// THE GUARD IS THE POINT. Every drop below is irreversible, so up() refuses to
// run at all if any of the three carries data: a row in referral_relationship
// or commission, or a credit_transaction still using a commission reason. On a
// deployment that has such rows this fails the pre-deploy migrate job with a
// readable message rather than destroying money history — decide what to do
// with those rows first, then re-run. The pre-launch wipe left prod at zero, so
// the expected outcome is that the guard passes silently.
//
// down() recreates the tables and columns EMPTY. It restores the schema, never
// the data — a reversal after any of this ran is a schema rollback only.
export class Migration20260824131342 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`DO $$
      DECLARE
        n_rel bigint := 0;
        n_comm bigint := 0;
        n_ledger bigint := 0;
      BEGIN
        IF to_regclass('public.referral_relationship') IS NOT NULL THEN
          EXECUTE 'SELECT count(*) FROM referral_relationship' INTO n_rel;
        END IF;
        IF to_regclass('public.commission') IS NOT NULL THEN
          EXECUTE 'SELECT count(*) FROM commission' INTO n_comm;
        END IF;
        IF to_regclass('public.credit_transaction') IS NOT NULL THEN
          EXECUTE $q$SELECT count(*) FROM credit_transaction
                      WHERE reason IN ('direct_referral','team_override','commission_reversal')$q$
            INTO n_ledger;
        END IF;
        IF n_rel > 0 OR n_comm > 0 OR n_ledger > 0 THEN
          RAISE EXCEPTION
            'Refusing to drop the referral schema: % referral_relationship row(s), % commission row(s), % commission ledger row(s). Resolve this data before removing the referral programme.',
            n_rel, n_comm, n_ledger;
        END IF;
      END $$;`);

    this.addSql(`drop table if exists "commission" cascade;`);
    this.addSql(`drop table if exists "referral_relationship" cascade;`);

    this.addSql(
      `alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" drop column if exists "generation";`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in ('buyback', 'topup', 'pack_open', 'adjustment', 'cashout', 'voucher_claim', 'reward_credit', 'daily_reward'));`,
    );

    this.addSql(
      `alter table if exists "ledger_entry" drop constraint if exists "ledger_entry_type_check";`,
    );
    this.addSql(
      `alter table if exists "ledger_entry" add constraint "ledger_entry_type_check" check("type" in ('TP', 'SP', 'SE', 'OD', 'AD', 'WP', 'WD'));`,
    );

    this.addSql(`alter table if exists "rewards_settings"
      drop column if exists "commission_cooldown_days",
      drop column if exists "team_override_pct",
      drop column if exists "raw_team_override_pct",
      drop column if exists "override_generation_cap";`);

    this.addSql(
      `alter table if exists "vip_level" drop column if exists "direct_referral_pct";`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `create table if not exists "commission" ("id" text not null, "credit_transaction_id" text not null, "beneficiary" text not null, "source_transaction_id" text not null, "generation" integer not null, "kind" text check ("kind" in ('direct', 'override')) not null default 'direct', "status" text check ("status" in ('pending', 'available', 'suspended', 'reversed')) not null default 'pending', "matures_at" timestamptz not null, "effective_pct" integer not null, "reversal_transaction_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "commission_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_commission_credit_transaction_id_unique" ON "commission" ("credit_transaction_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_commission_deleted_at" ON "commission" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_commission_beneficiary" ON "commission" ("beneficiary") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_commission_source_transaction_id" ON "commission" ("source_transaction_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_commission_pending_matures_at" ON "commission" ("matures_at") WHERE status = 'pending' AND deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "referral_relationship" ("id" text not null, "customer_id" text not null, "sponsor_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "referral_relationship_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_referral_relationship_customer_id_unique" ON "referral_relationship" ("customer_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_referral_relationship_deleted_at" ON "referral_relationship" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_referral_relationship_sponsor_id" ON "referral_relationship" ("sponsor_id") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" add column if not exists "generation" integer null;`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in ('buyback', 'topup', 'pack_open', 'adjustment', 'direct_referral', 'team_override', 'commission_reversal', 'cashout', 'voucher_claim', 'reward_credit', 'daily_reward'));`,
    );

    this.addSql(
      `alter table if exists "ledger_entry" drop constraint if exists "ledger_entry_type_check";`,
    );
    this.addSql(
      `alter table if exists "ledger_entry" add constraint "ledger_entry_type_check" check("type" in ('TP', 'SP', 'SE', 'OD', 'RF', 'AD', 'WP', 'WD'));`,
    );

    this.addSql(`alter table if exists "rewards_settings"
      add column if not exists "commission_cooldown_days" integer not null default 3,
      add column if not exists "team_override_pct" numeric not null default 0.2,
      add column if not exists "raw_team_override_pct" jsonb not null default '{"value":"0.2","precision":20}',
      add column if not exists "override_generation_cap" integer not null default 100;`);

    // DEFAULT 1 (the L1 rate), unlike the generated inverse: re-adding a NOT
    // NULL column with no default fails outright on a seeded ladder.
    this.addSql(
      `alter table if exists "vip_level" add column if not exists "direct_referral_pct" integer not null default 1;`,
    );
  }
}
