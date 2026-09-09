import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Partner groups (spec docs/superpowers/specs/2026-09-09-partner-groups-design.md):
// editGroupPolicy writes an admin_action_audit row with entity_type
// 'customer_group' and action 'edit_group_policy'. The model enums gained both
// values, but the DB CHECKs are only rewritten by an explicit migration
// (Migration20260906090000 learned this the hard way), so both constraints
// are dropped and re-added here with the full current lists.
//
// The group policy itself lives in customer_group.metadata (core table, jsonb)
// — no schema change for it.

const ENTITY_TYPES_BEFORE = [
  'customer',
  'commission',
  'rewards_settings',
  'credit',
  'reward_pool',
  'daily_reward_settings',
  'daily_box',
  'voucher_ladder',
  'fx',
  'site_settings',
  'vip_levels',
  'challenge_stages',
  'challenge_settings',
  'delivery_order',
  'purchase_invoice',
  'tier_settings',
  'referral_settings',
  'weekly_settlement',
  'task_definition',
];
const ENTITY_TYPES_AFTER = [...ENTITY_TYPES_BEFORE, 'customer_group'];

const ACTIONS_BEFORE = [
  'freeze',
  'unfreeze',
  'reverse_commission',
  'suspend_commission',
  'unsuspend_commission',
  'adjust_credit',
  'edit_rewards_settings',
  'edit_reward_pool',
  'edit_daily_reward_settings',
  'edit_daily_box',
  'edit_voucher_ladder',
  'edit_fx_rate',
  'edit_site_settings',
  'edit_payment_gateway',
  'edit_avatar_frames',
  'replace',
  'edit',
  'bulk_status',
  'disable',
  'enable',
  'create',
  'reveal',
  'delete_account',
  'set_partner_rate',
  'edit_referral_settings',
  'approve_settlement',
  'void_settlement_line',
  'void_settlement',
  'pay_settlement',
];
const ACTIONS_AFTER = [...ACTIONS_BEFORE, 'edit_group_policy'];

const inList = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export class Migration20260909090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in (${inList(ENTITY_TYPES_AFTER)}));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in (${inList(ACTIONS_AFTER)}));`,
    );
  }

  override async down(): Promise<void> {
    // Narrowing back would fail against any row the new action wrote, so the
    // down path re-adds the previous lists only when none exist.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM admin_action_audit WHERE action = 'edit_group_policy' OR entity_type = 'customer_group') THEN
          RAISE EXCEPTION 'admin_action_audit holds edit_group_policy rows; refusing to narrow the CHECKs';
        END IF;
      END $$;`);
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in (${inList(ENTITY_TYPES_BEFORE)}));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in (${inList(ACTIONS_BEFORE)}));`,
    );
  }
}
