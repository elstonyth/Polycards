import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Daily check-in reward (storefront redesign Phase 5): claim ledger table +
// settings singleton + the two enum CHECK widenings (credit reason
// 'daily_reward', audit entity/action). Hand-trimmed from db:generate output —
// the generator also emitted unrelated fx_rate/card drift (already applied by
// earlier migrations) which was removed so down() can never drop live tables.
export class Migration20260702083351 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "daily_claim" ("id" text not null, "customer_id" text not null, "claim_day" text not null, "streak_day" integer not null, "amount" numeric not null, "raw_amount" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "daily_claim_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_daily_claim_deleted_at" ON "daily_claim" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_daily_claim_customer_day" ON "daily_claim" ("customer_id", "claim_day") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "daily_reward_settings" ("id" text not null, "enabled" boolean not null default true, "amounts" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "daily_reward_settings_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_daily_reward_settings_deleted_at" ON "daily_reward_settings" ("deleted_at") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );

    this.addSql(
      `alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`,
    );

    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in ('customer', 'commission', 'rewards_settings', 'credit', 'reward_pool', 'daily_reward_settings'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in ('freeze', 'unfreeze', 'reverse_commission', 'suspend_commission', 'unsuspend_commission', 'adjust_credit', 'edit_rewards_settings', 'edit_reward_pool', 'edit_daily_reward_settings'));`,
    );

    this.addSql(
      `alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in ('buyback', 'topup', 'pack_open', 'adjustment', 'direct_referral', 'team_override', 'commission_reversal', 'cashout', 'voucher_claim', 'reward_credit', 'daily_reward'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "daily_claim" cascade;`);

    this.addSql(`drop table if exists "daily_reward_settings" cascade;`);

    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );

    this.addSql(
      `alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`,
    );

    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in ('customer', 'commission', 'rewards_settings', 'credit', 'reward_pool'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in ('freeze', 'unfreeze', 'reverse_commission', 'suspend_commission', 'unsuspend_commission', 'adjust_credit', 'edit_rewards_settings', 'edit_reward_pool'));`,
    );

    this.addSql(
      `alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in ('buyback', 'topup', 'pack_open', 'adjustment', 'direct_referral', 'team_override', 'commission_reversal', 'cashout', 'voucher_claim', 'reward_credit'));`,
    );
  }
}
