import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Settlement's Acknowledge (2026-10-15). An operator can acknowledge a gateway
// audit finding they have dealt with, with a reason. The row records which
// note was acknowledged, by whom (admin email) and when. While its note is
// still that one it no longer counts in the "payments differ" badge or the
// Dashboard. The reason goes to admin_action_audit, whose CHECK lists gain
// the 'gateway_deposit' entity and the 'acknowledge_finding' action. Both
// lists are re-emitted in full, as every CHECK-rewriting migration does, so
// migrations/__tests__/admin-audit-config-enums.unit.spec.ts can read them
// back from the latest one.
//
// Hand-written. Three nullable columns on each gateway table and no row
// written; old code ignores them, so DEPLOY ORDER is the usual
// migrate-then-serve.

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
];
const ENTITY_TYPES_AFTER = [...ENTITY_TYPES_BEFORE, 'gateway_deposit'];
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
];
const ACTIONS_AFTER = [...ACTIONS_BEFORE, 'acknowledge_finding'];

const TABLES = ['gateway_deposit', 'gateway_withdrawal'];
const COLUMNS = [
  ['audit_ack_note', 'text'],
  ['audit_ack_by', 'text'],
  ['audit_ack_at', 'timestamptz'],
];

const inList = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export class Migration20261015160000 extends Migration {
  override async up(): Promise<void> {
    // Deposits and payouts are written all day: fail the deploy fast rather
    // than queue callbacks behind the ALTER's lock.
    this.addSql(`set local lock_timeout = '5s';`);
    for (const table of TABLES) {
      for (const [column, type] of COLUMNS) {
        this.addSql(
          `alter table if exists "${table}" add column if not exists "${column}" ${type} null;`,
        );
      }
    }
    this.checks(ENTITY_TYPES_AFTER, ACTIONS_AFTER);
  }

  override async down(): Promise<void> {
    // Narrowing the CHECKs fails against rows that use the new values:
    // refuse while any exists.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM admin_action_audit WHERE action = 'acknowledge_finding' OR entity_type = 'gateway_deposit')
        THEN
          RAISE EXCEPTION 'acknowledge_finding audit rows exist; refusing to unwind Migration20261015160000';
        END IF;
      END $$;`);
    this.checks(ENTITY_TYPES_BEFORE, ACTIONS_BEFORE);
    for (const table of TABLES) {
      for (const [column] of COLUMNS) {
        this.addSql(
          `alter table if exists "${table}" drop column if exists "${column}";`,
        );
      }
    }
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
