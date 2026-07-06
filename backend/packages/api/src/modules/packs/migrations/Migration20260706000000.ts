import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Widen admin_action_audit CHECKs to admit FX-rate override edits:
//   entity_type += 'fx', action += 'edit_fx_rate'. Appends to the current
//   (post-Migration20260704072247) lists.
export class Migration20260706000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );

    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in ('customer', 'commission', 'rewards_settings', 'credit', 'reward_pool', 'daily_reward_settings', 'daily_box', 'voucher_ladder', 'fx'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in ('freeze', 'unfreeze', 'reverse_commission', 'suspend_commission', 'unsuspend_commission', 'adjust_credit', 'edit_rewards_settings', 'edit_reward_pool', 'edit_daily_reward_settings', 'edit_daily_box', 'edit_voucher_ladder', 'edit_fx_rate'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );

    // Lossy rollback (same convention as Migration20260704072247): the pre-fx
    // CHECK cannot represent 'fx'/'edit_fx_rate' rows, so drop them before
    // re-adding the narrower constraint.
    this.addSql(
      `delete from "admin_action_audit" where "entity_type" = 'fx';`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in ('customer', 'commission', 'rewards_settings', 'credit', 'reward_pool', 'daily_reward_settings', 'daily_box', 'voucher_ladder'));`,
    );

    this.addSql(
      `delete from "admin_action_audit" where "action" = 'edit_fx_rate';`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in ('freeze', 'unfreeze', 'reverse_commission', 'suspend_commission', 'unsuspend_commission', 'adjust_credit', 'edit_rewards_settings', 'edit_reward_pool', 'edit_daily_reward_settings', 'edit_daily_box', 'edit_voucher_ladder'));`,
    );
  }
}
