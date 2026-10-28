import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Action 'release_reward_holds' on the admin_action_audit CHECK: the one-shot
// release of the holds that task / challenge reward and gift sales stamped
// before ADR 0012 writes one audit row per customer, and that row is what keeps
// a re-run from ever releasing top-up money (releaseOldRewardHoldsForCustomer).
// Both CHECK lists are re-emitted in full, as every CHECK-rewriting migration
// does, so migrations/__tests__/admin-audit-config-enums.unit.spec.ts can read
// them back from the latest one. Entity types are unchanged.
//
// Additive: old code never writes the new action, so DEPLOY ORDER is the usual
// migrate-then-serve.

// NOT exported: the migration loader takes a migration file's first export as
// its class.
const ENTITY_TYPES = [
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
  'pack',
  'card',
  'announcement',
  'pack_gift',
];
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
  'delete',
  'edit_odds',
  'edit_members',
  'edit_top_hits',
  'reorder',
  'edit_odds_set',
  'set_player_group',
  'set_real_name',
  'set_phone',
  'grant_pack_gift',
  'revoke_pack_gift',
  'grant_bonus_credit',
];
const ACTIONS_AFTER = [...ACTIONS_BEFORE, 'release_reward_holds'];

const inList = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export class Migration20261015120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in (${inList(ENTITY_TYPES)}));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in (${inList(ACTIONS_AFTER)}));`,
    );
  }

  override async down(): Promise<void> {
    // Narrowing the CHECK fails against rows that use the new action, and
    // those rows are the one-shot guard: refuse while any exists.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM admin_action_audit WHERE action = 'release_reward_holds')
        THEN
          RAISE EXCEPTION 'release_reward_holds audit rows exist; refusing to unwind Migration20261015120000';
        END IF;
      END $$;`);
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in (${inList(ACTIONS_BEFORE)}));`,
    );
  }
}
