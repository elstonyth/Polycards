import { Migration } from '@mikro-orm/migrations';

// Referral rebuild Phase A (spec 2026-08-24): attribution, settings and the
// weekly settlement run/line tables, the partner + rebate columns, and the
// two widened CHECKs (credit_transaction.reason + referral_commission /
// vip_rebate; ledger_entry.type + RF). Hand-written — db:generate's output
// also re-emits unrelated snapshot drift (see memory
// db-generate-never-sees-live-db), so only its snapshot half is kept.
//
// up() is purely additive. down() is destructive and therefore guarded: it
// refuses to run while any data the new system wrote still exists.
export class Migration20260824150000 extends Migration {
  override async up(): Promise<void> {
    // -- referral_attribution ------------------------------------------------
    this.addSql(
      `create table if not exists "referral_attribution" ("id" text not null, "customer_id" text not null, "referrer_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "referral_attribution_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_referral_attribution_customer_id_unique" ON "referral_attribution" ("customer_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_referral_attribution_deleted_at" ON "referral_attribution" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_referral_attribution_referrer" ON "referral_attribution" ("referrer_id") WHERE deleted_at IS NULL;`,
    );

    // -- referral_settings (singleton, lazy-seeded by the service) -----------
    this.addSql(
      `create table if not exists "referral_settings" ("id" text not null, "tiers" jsonb not null, "partner_min_bp" integer not null default 300, "partner_max_bp" integer not null default 500, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "referral_settings_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_referral_settings_deleted_at" ON "referral_settings" ("deleted_at") WHERE deleted_at IS NULL;`,
    );

    // -- weekly_settlement ---------------------------------------------------
    this.addSql(
      `create table if not exists "weekly_settlement" ("id" text not null, "week_start" timestamptz not null, "status" text check ("status" in ('draft', 'approved', 'paid', 'void')) not null default 'draft', "approved_by" text null, "approved_at" timestamptz null, "paid_at" timestamptz null, "total_commission_cents" integer not null default 0, "total_rebate_cents" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "weekly_settlement_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_weekly_settlement_week_start_unique" ON "weekly_settlement" ("week_start") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_weekly_settlement_deleted_at" ON "weekly_settlement" ("deleted_at") WHERE deleted_at IS NULL;`,
    );

    // -- weekly_settlement_line ----------------------------------------------
    this.addSql(
      `create table if not exists "weekly_settlement_line" ("id" text not null, "settlement_id" text not null, "customer_id" text not null, "kind" text check ("kind" in ('referral_commission', 'vip_rebate')) not null, "basis_cents" integer not null, "rate_bp" integer not null, "amount_cents" integer not null, "status" text check ("status" in ('pending', 'voided', 'paid')) not null default 'pending', "void_reason" text null, "voided_by" text null, "paid_transaction_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "weekly_settlement_line_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_weekly_settlement_line_deleted_at" ON "weekly_settlement_line" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_wsl_settlement" ON "weekly_settlement_line" ("settlement_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_wsl_customer" ON "weekly_settlement_line" ("customer_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_wsl_settlement_customer_kind_unique" ON "weekly_settlement_line" ("settlement_id", "customer_id", "kind") WHERE deleted_at IS NULL;`,
    );

    // -- column additions ----------------------------------------------------
    this.addSql(
      `alter table if exists "customer_account_state" add column if not exists "partner_referral_bp" integer null;`,
    );
    this.addSql(
      `alter table if exists "vip_level" add column if not exists "rebate_bp" integer not null default 0;`,
    );

    // -- widened CHECKs ------------------------------------------------------
    this.addSql(
      `alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in ('buyback', 'topup', 'pack_open', 'adjustment', 'cashout', 'voucher_claim', 'reward_credit', 'daily_reward', 'referral_commission', 'vip_rebate'));`,
    );
    this.addSql(
      `alter table if exists "ledger_entry" drop constraint if exists "ledger_entry_type_check";`,
    );
    this.addSql(
      `alter table if exists "ledger_entry" add constraint "ledger_entry_type_check" check("type" in ('TP', 'SP', 'SE', 'OD', 'AD', 'WP', 'WD', 'RF'));`,
    );
  }

  override async down(): Promise<void> {
    // Refuse to unwind while the new system's data exists — dropping these
    // rows would destroy money history. Same recipe as Migration20260824131342
    // (the RAISE branch of that guard was proven to fire).
    this.addSql(`DO $$
      DECLARE
        n_attr bigint := 0; n_settle bigint := 0; n_ledger bigint := 0; n_rf bigint := 0;
      BEGIN
        IF to_regclass('public.referral_attribution') IS NOT NULL THEN
          EXECUTE 'SELECT count(*) FROM referral_attribution' INTO n_attr;
        END IF;
        IF to_regclass('public.weekly_settlement') IS NOT NULL THEN
          EXECUTE 'SELECT count(*) FROM weekly_settlement' INTO n_settle;
        END IF;
        IF to_regclass('public.credit_transaction') IS NOT NULL THEN
          EXECUTE $q$SELECT count(*) FROM credit_transaction
                      WHERE reason IN ('referral_commission','vip_rebate')$q$
            INTO n_ledger;
        END IF;
        IF to_regclass('public.ledger_entry') IS NOT NULL THEN
          EXECUTE $q$SELECT count(*) FROM ledger_entry WHERE type = 'RF'$q$
            INTO n_rf;
        END IF;
        IF n_attr > 0 OR n_settle > 0 OR n_ledger > 0 OR n_rf > 0 THEN
          RAISE EXCEPTION
            'Refusing to unwind the referral rebuild: % attribution row(s), % settlement row(s), % payout ledger row(s), % RF ledger row(s). Clear them deliberately first.',
            n_attr, n_settle, n_ledger, n_rf;
        END IF;
      END $$;`);

    this.addSql(`drop table if exists "weekly_settlement_line" cascade;`);
    this.addSql(`drop table if exists "weekly_settlement" cascade;`);
    this.addSql(`drop table if exists "referral_settings" cascade;`);
    this.addSql(`drop table if exists "referral_attribution" cascade;`);
    this.addSql(
      `alter table if exists "customer_account_state" drop column if exists "partner_referral_bp";`,
    );
    this.addSql(
      `alter table if exists "vip_level" drop column if exists "rebate_bp";`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`,
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
  }
}
