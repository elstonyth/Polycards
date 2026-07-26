import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Bulk delivery-status tool (POLYCARD-BACK §1.3) writes one audit row per
// changed order, so admin_action_audit gains entity_type 'delivery_order' and
// action 'bulk_status'. Both enums live in a CHECK on their text column, so
// each is dropped and re-added with the full current value list from
// models/admin-action-audit.ts plus the new value.
export class Migration20260727000001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check ("entity_type" in ('customer','commission','rewards_settings','credit','reward_pool','daily_reward_settings','daily_box','voucher_ladder','fx','site_settings','vip_levels','challenge_stages','challenge_settings','delivery_order'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check ("action" in ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_daily_reward_settings','edit_daily_box','edit_voucher_ladder','edit_fx_rate','edit_site_settings','edit_avatar_frames','replace','edit','bulk_status'));`,
    );
  }

  override async down(): Promise<void> {
    // Audit rows are append-only, so a down() that narrows the enums would
    // fail on any row already written by the bulk tool — drop those first.
    this.addSql(
      `delete from "admin_action_audit" where "entity_type" = 'delivery_order' or "action" = 'bulk_status';`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check ("entity_type" in ('customer','commission','rewards_settings','credit','reward_pool','daily_reward_settings','daily_box','voucher_ladder','fx','site_settings','vip_levels','challenge_stages','challenge_settings'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check ("action" in ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_daily_reward_settings','edit_daily_box','edit_voucher_ladder','edit_fx_rate','edit_site_settings','edit_avatar_frames','replace','edit'));`,
    );
  }
}
