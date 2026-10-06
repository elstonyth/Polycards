import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Real name + phone lock (spec 2026-10-06): customer_account_state.real_name /
// real_name_set_at, and actions 'set_real_name' / 'set_phone' on the
// admin_action_audit CHECK (customer service corrects either one, audited).
// Hand-written — db:generate re-emits unrelated snapshot drift; only the two
// columns were added to .snapshot-packs.json.
//
// DEPLOY ORDER: run this before the new code serves traffic. Without the
// columns every account-state read that selects them fails; without the
// widened CHECK every admin correction fails its audit insert and rolls back.

// NOT exported: the migration loader takes a migration file's first export as
// its class. migrations/__tests__/admin-audit-config-enums.unit.spec.ts reads
// the lists back out of the emitted SQL instead.

// Unchanged by this migration — re-emitted so the CHECK pair stays a full,
// current statement of both lists (the pin test reads both from here).
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
];
const ACTIONS_AFTER = [...ACTIONS_BEFORE, 'set_real_name', 'set_phone'];

const inList = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export class Migration20261006120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_account_state" add column if not exists "real_name" text null, add column if not exists "real_name_set_at" timestamptz null;`,
    );
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
    // Narrowing the CHECK would fail against the new audit rows, and dropping
    // the columns destroys every real name customers entered — refuse while
    // either exists rather than lose data silently.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM admin_action_audit WHERE action IN ('set_real_name', 'set_phone')
        ) OR EXISTS (
          SELECT 1 FROM customer_account_state WHERE real_name IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'real names or real-name/phone audit rows exist; refusing to unwind the real-name migration';
        END IF;
      END $$;`);
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in (${inList(ACTIONS_BEFORE)}));`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" drop column if exists "real_name", drop column if exists "real_name_set_at";`,
    );
  }
}
