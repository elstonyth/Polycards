import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Admin two-step sign-in (owner, 2026-11-07): a Super Admin resetting another
// admin's authenticator is audited as action 'reset_mfa' on entity
// 'admin_user' (a user id). Both CHECK lists on admin_action_audit are
// re-emitted in full, as every CHECK-rewriting migration does, so
// migrations/__tests__/admin-audit-config-enums.unit.spec.ts can read them back
// from this one.
//
// Hand-written. Old code never writes the new values, so DEPLOY ORDER is the
// usual migrate-then-serve. lock_timeout: the CHECK swap takes a short
// exclusive lock on admin_action_audit against live traffic; past 5 s it gives
// up and the deploy can be retried, rather than queueing every audit write.
// NOT exported: the migration loader takes a migration file's first export as
// its class.
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
  'pack',
  'card',
  'announcement',
  'pack_gift',
  'coin_flip_config',
  'gateway_deposit',
  'lucky_draw_event',
  'lucky_draw_prize',
  'goods_receive_note',
];
const ENTITY_TYPES_AFTER = [...ENTITY_TYPES_BEFORE, 'admin_user'];
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
  'release_reward_holds',
  'acknowledge_finding',
  'publish',
];
const ACTIONS_AFTER = [...ACTIONS_BEFORE, 'reset_mfa'];

const inList = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

const swapChecks = (entityTypes: string[], actions: string[]): string[] => [
  `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
  `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in (${inList(entityTypes)}));`,
  `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
  `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in (${inList(actions)}));`,
];

export class Migration20261107120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    for (const sql of swapChecks(ENTITY_TYPES_AFTER, ACTIONS_AFTER)) {
      this.addSql(sql);
    }
  }

  override async down(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    // Refuses rather than orphaning audit rows the old CHECKs would reject.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM admin_action_audit WHERE entity_type = 'admin_user' OR action = 'reset_mfa') THEN
          RAISE EXCEPTION 'admin_action_audit holds two-step reset rows; keep this migration';
        END IF;
      END $$;`);
    for (const sql of swapChecks(ENTITY_TYPES_BEFORE, ACTIONS_BEFORE)) {
      this.addSql(sql);
    }
  }
}
