import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Player disable switch (POLYCARD-BACK §4.2): customer_account_state gains a
// `disabled` login-block flag, orthogonal to `frozen` (funds lock). Additive =
// expand-safe (old code never reads the new columns). Also widens the
// admin_action_audit action CHECK with 'disable'/'enable'.
export class Migration20260728100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_account_state" add column if not exists "disabled" boolean not null default false;`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" add column if not exists "disabled_reason" text null;`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" add column if not exists "disabled_by" text null;`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" add column if not exists "disabled_at" timestamptz null;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_customer_account_state_disabled" ON "customer_account_state" (customer_id) WHERE disabled = true AND deleted_at IS NULL;`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check ("action" in ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_daily_reward_settings','edit_daily_box','edit_voucher_ladder','edit_fx_rate','edit_site_settings','edit_avatar_frames','replace','edit','bulk_status','disable','enable'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `delete from "admin_action_audit" where "action" in ('disable','enable');`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check ("action" in ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_daily_reward_settings','edit_daily_box','edit_voucher_ladder','edit_fx_rate','edit_site_settings','edit_avatar_frames','replace','edit','bulk_status'));`,
    );
    this.addSql(`DROP INDEX IF EXISTS "IDX_customer_account_state_disabled";`);
    this.addSql(
      `alter table if exists "customer_account_state" drop column if exists "disabled_at";`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" drop column if exists "disabled_by";`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" drop column if exists "disabled_reason";`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" drop column if exists "disabled";`,
    );
  }
}
