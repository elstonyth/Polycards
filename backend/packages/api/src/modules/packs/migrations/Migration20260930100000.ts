import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Config-change trail (2026-09-30): pack settings, pack odds, card removals,
// player-group odds sets and player moves now write admin_action_audit rows,
// so the odds and buyback rate in force at any past moment can be proven
// instead of inferred from sales. The model enums gained the values; the DB
// CHECKs are only rewritten by an explicit migration, so both constraints are
// dropped and re-added with the full current lists.
//
// DEPLOY ORDER MATTERS: these audit rows are written as the LAST step of the
// pack/odds workflows, and a failed audit rolls the change back. Code that
// writes the new values against a DB without this migration would refuse
// every pack, odds and membership save. Run migrations before the new code
// serves traffic.

// NOT exported: the migration loader takes a migration file's first export as
// its class ("MigrationClass is not a constructor"), so only the class is
// exported. migrations/__tests__/admin-audit-config-enums.unit.spec.ts reads
// the lists back out of the emitted SQL instead.
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
  'customer_group',
  'gateway_withdrawal',
];
const ENTITY_TYPES_AFTER = [...ENTITY_TYPES_BEFORE, 'pack', 'card'];

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
  'edit_group_policy',
  'approve_withdrawal',
  'deny_withdrawal',
];
const NEW_ACTIONS = [
  'delete',
  'edit_odds',
  'edit_members',
  'edit_top_hits',
  'reorder',
  'edit_odds_set',
  'set_player_group',
];
const ACTIONS_AFTER = [...ACTIONS_BEFORE, ...NEW_ACTIONS];

const inList = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export class Migration20260930100000 extends Migration {
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
    // Narrowing back would fail against any row the new values wrote, so the
    // down path re-adds the previous lists only when none exist.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM admin_action_audit
          WHERE entity_type IN ('pack', 'card')
             OR action IN (${inList(NEW_ACTIONS)})
        ) THEN
          RAISE EXCEPTION 'admin_action_audit holds config-change rows; refusing to narrow the CHECKs';
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
