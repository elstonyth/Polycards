import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Challenge config layer: challenge_stage (milestone stages) + challenge_settings
// (week/payout singleton, CHECK id='global'). Also widen admin_action_audit
// CHECKs: entity_type += 'challenge_stages','challenge_settings'; action +=
// 'edit'. Full cumulative lists (carry Task 2's 'vip_levels'/'replace').
export class Migration20260719010000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "challenge_stage" (
      "id" text not null,
      "stage_number" integer not null,
      "threshold_myr" numeric not null,
      "raw_threshold_myr" jsonb not null,
      "reward_credits" numeric not null,
      "raw_reward_credits" jsonb not null,
      "reward_card_ids" jsonb not null default '[]',
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz null,
      constraint "challenge_stage_pkey" primary key ("id")
    );`);
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_challenge_stage_stage_number_unique" ON "challenge_stage" ("stage_number") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_challenge_stage_deleted_at" ON "challenge_stage" ("deleted_at") WHERE deleted_at IS NULL;`,
    );

    this.addSql(`create table if not exists "challenge_settings" (
      "id" text not null,
      "cadence" text not null default 'fixed_weekly',
      "timezone" text not null default 'Asia/Kuala_Lumpur',
      "reset_day" integer not null default 1,
      "reset_hour" integer not null default 0,
      "payout_credits" numeric not null default 0,
      "raw_payout_credits" jsonb not null default '{"value":"0","precision":20}',
      "payout_card_ids" jsonb not null default '[]',
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz null,
      constraint "challenge_settings_pkey" primary key ("id"),
      constraint "challenge_settings_singleton_id_check" check ("id" = 'global')
    );`);
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_challenge_settings_deleted_at" ON "challenge_settings" ("deleted_at") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in ('customer', 'commission', 'rewards_settings', 'credit', 'reward_pool', 'daily_reward_settings', 'daily_box', 'voucher_ladder', 'fx', 'site_settings', 'vip_levels', 'challenge_stages', 'challenge_settings'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in ('freeze', 'unfreeze', 'reverse_commission', 'suspend_commission', 'unsuspend_commission', 'adjust_credit', 'edit_rewards_settings', 'edit_reward_pool', 'edit_daily_reward_settings', 'edit_daily_box', 'edit_voucher_ladder', 'edit_fx_rate', 'edit_site_settings', 'edit_avatar_frames', 'replace', 'edit'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `delete from "admin_action_audit" where "entity_type" in ('challenge_stages', 'challenge_settings');`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in ('customer', 'commission', 'rewards_settings', 'credit', 'reward_pool', 'daily_reward_settings', 'daily_box', 'voucher_ladder', 'fx', 'site_settings', 'vip_levels'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(`delete from "admin_action_audit" where "action" = 'edit';`);
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in ('freeze', 'unfreeze', 'reverse_commission', 'suspend_commission', 'unsuspend_commission', 'adjust_credit', 'edit_rewards_settings', 'edit_reward_pool', 'edit_daily_reward_settings', 'edit_daily_box', 'edit_voucher_ladder', 'edit_fx_rate', 'edit_site_settings', 'edit_avatar_frames', 'replace'));`,
    );

    this.addSql(`drop table if exists "challenge_stage" cascade;`);
    this.addSql(`drop table if exists "challenge_settings" cascade;`);
  }
}
