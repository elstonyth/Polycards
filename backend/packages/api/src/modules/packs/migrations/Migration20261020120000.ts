import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Settle a held USDT deposit for what arrived (2026-10-20). Staff can credit a
// deposit the sweep held because the payment landed further from its order
// than the rail credits automatically: the amount is the gateway's own
// requery, credited at the row's locked rate through the same idempotency
// anchor as the callback and the sweep (modules/packs/settle-arrived.ts).
// The decision goes to admin_action_audit, whose action CHECK gains
// 'settle_deposit' (entity 'gateway_deposit', already allowed). Both lists
// are re-emitted in full, as every CHECK-rewriting migration does, so
// migrations/__tests__/admin-audit-config-enums.unit.spec.ts can read them
// back from the latest one.
//
// Hand-written. No column and no row: only the CHECK widens, so old code is
// unaffected and DEPLOY ORDER is the usual migrate-then-serve.

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
  'gateway_deposit',
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
  'release_reward_holds',
  'acknowledge_finding',
];
const ACTIONS_AFTER = [...ACTIONS_BEFORE, 'settle_deposit'];

const inList = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export class Migration20261020120000 extends Migration {
  override async up(): Promise<void> {
    // The audit table is written by every admin money action: fail the
    // deploy fast rather than queue them behind the ALTER's lock.
    this.addSql(`set local lock_timeout = '5s';`);
    this.checks(ENTITY_TYPES, ACTIONS_AFTER);
  }

  override async down(): Promise<void> {
    // Narrowing the CHECK fails against rows that use the new value: refuse
    // while any exists.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM admin_action_audit WHERE action = 'settle_deposit')
        THEN
          RAISE EXCEPTION 'settle_deposit audit rows exist; refusing to unwind Migration20261020120000';
        END IF;
      END $$;`);
    this.checks(ENTITY_TYPES, ACTIONS_BEFORE);
  }

  private checks(entityTypes: string[], actions: string[]): void {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in (${inList(entityTypes)}));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in (${inList(actions)}));`,
    );
  }
}
