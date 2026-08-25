import { Migration } from '@mikro-orm/migrations';

// Referral rebuild Phase A (spec 2026-08-24): attribution, settings and the
// weekly settlement run/line tables, the partner column, and the two widened
// CHECKs (credit_transaction.reason + referral_commission;
// ledger_entry.type + RF). Hand-written — db:generate's output
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
      `create table if not exists "weekly_settlement" ("id" text not null, "week_start" timestamptz not null, "status" text check ("status" in ('draft', 'approved', 'paid', 'void')) not null default 'draft', "approved_by" text null, "approved_at" timestamptz null, "paid_at" timestamptz null, "total_commission_cents" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "weekly_settlement_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_weekly_settlement_week_start_unique" ON "weekly_settlement" ("week_start") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_weekly_settlement_deleted_at" ON "weekly_settlement" ("deleted_at") WHERE deleted_at IS NULL;`,
    );

    // -- weekly_settlement_line ----------------------------------------------
    this.addSql(
      `create table if not exists "weekly_settlement_line" ("id" text not null, "settlement_id" text not null, "customer_id" text not null, "basis_cents" integer not null, "rate_bp" integer not null, "amount_cents" integer not null, "status" text check ("status" in ('pending', 'voided', 'paid')) not null default 'pending', "void_reason" text null, "voided_by" text null, "paid_transaction_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "weekly_settlement_line_pkey" primary key ("id"));`,
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
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_wsl_settlement_customer_unique" ON "weekly_settlement_line" ("settlement_id", "customer_id") WHERE deleted_at IS NULL;`,
    );

    // -- task system (Phase B) -----------------------------------------------
    this.addSql(
      `create table if not exists "task_definition" ("id" text not null, "kind" text check ("kind" in ('weekly', 'achievement')) not null, "title" text not null, "requirement" jsonb not null, "reward" jsonb not null, "active" boolean not null default true, "sort" integer not null default 0, "starts_at" timestamptz null, "ends_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "task_definition_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_task_definition_deleted_at" ON "task_definition" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `create table if not exists "task_claim" ("id" text not null, "customer_id" text not null, "task_id" text not null, "period_key" text not null default '', "reward_snapshot" jsonb null, "claim_ref" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "task_claim_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_task_claim_deleted_at" ON "task_claim" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_task_claim_customer" ON "task_claim" ("customer_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_task_claim_unique" ON "task_claim" ("customer_id", "task_id", "period_key") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `create table if not exists "daily_checkin" ("id" text not null, "customer_id" text not null, "checkin_date" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "daily_checkin_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_daily_checkin_deleted_at" ON "daily_checkin" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_daily_checkin_unique" ON "daily_checkin" ("customer_id", "checkin_date") WHERE deleted_at IS NULL;`,
    );

    // -- column additions ----------------------------------------------------
    this.addSql(
      `alter table if exists "customer_account_state" add column if not exists "partner_referral_bp" integer null;`,
    );
    // -- widened CHECKs ------------------------------------------------------
    this.addSql(
      `alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in ('buyback', 'topup', 'pack_open', 'adjustment', 'cashout', 'voucher_claim', 'reward_credit', 'daily_reward', 'referral_commission'));`,
    );
    this.addSql(
      `alter table if exists "ledger_entry" drop constraint if exists "ledger_entry_type_check";`,
    );
    this.addSql(
      `alter table if exists "ledger_entry" add constraint "ledger_entry_type_check" check("type" in ('TP', 'SP', 'SE', 'OD', 'AD', 'WP', 'WD', 'RF'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in ('customer', 'commission', 'rewards_settings', 'credit', 'reward_pool', 'daily_reward_settings', 'daily_box', 'voucher_ladder', 'fx', 'site_settings', 'vip_levels', 'challenge_stages', 'challenge_settings', 'delivery_order', 'purchase_invoice', 'tier_settings', 'referral_settings', 'weekly_settlement', 'task_definition'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in ('freeze', 'unfreeze', 'reverse_commission', 'suspend_commission', 'unsuspend_commission', 'adjust_credit', 'edit_rewards_settings', 'edit_reward_pool', 'edit_daily_reward_settings', 'edit_daily_box', 'edit_voucher_ladder', 'edit_fx_rate', 'edit_site_settings', 'edit_avatar_frames', 'replace', 'edit', 'bulk_status', 'disable', 'enable', 'create', 'reveal', 'delete_account', 'set_partner_rate', 'edit_referral_settings', 'approve_settlement', 'void_settlement_line', 'void_settlement', 'pay_settlement'));`,
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
                      WHERE reason = 'referral_commission'$q$
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

    this.addSql(`drop table if exists "task_claim" cascade;`);
    this.addSql(`drop table if exists "task_definition" cascade;`);
    this.addSql(`drop table if exists "daily_checkin" cascade;`);
    this.addSql(`drop table if exists "weekly_settlement_line" cascade;`);
    this.addSql(`drop table if exists "weekly_settlement" cascade;`);
    this.addSql(`drop table if exists "referral_settings" cascade;`);
    this.addSql(`drop table if exists "referral_attribution" cascade;`);
    this.addSql(
      `alter table if exists "customer_account_state" drop column if exists "partner_referral_bp";`,
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
    // Narrow the audit CHECKs back. Deliberately unguarded: Postgres validates
    // existing rows when the constraint is added, so a row carrying one of the
    // new values fails this loudly instead of being silently stranded.
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in ('customer', 'commission', 'rewards_settings', 'credit', 'reward_pool', 'daily_reward_settings', 'daily_box', 'voucher_ladder', 'fx', 'site_settings', 'vip_levels', 'challenge_stages', 'challenge_settings', 'delivery_order', 'purchase_invoice', 'tier_settings'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in ('freeze', 'unfreeze', 'reverse_commission', 'suspend_commission', 'unsuspend_commission', 'adjust_credit', 'edit_rewards_settings', 'edit_reward_pool', 'edit_daily_reward_settings', 'edit_daily_box', 'edit_voucher_ladder', 'edit_fx_rate', 'edit_site_settings', 'edit_avatar_frames', 'replace', 'edit', 'bulk_status', 'disable', 'enable', 'create', 'reveal', 'delete_account'));`,
    );
  }
}
