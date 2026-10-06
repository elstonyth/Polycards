import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Pack gifts + bonus credit (spec 2026-10-07 §3):
//   - credit_transaction.bonus_cents (signed sen of a row that is spend-only
//     bonus) and reason 'bonus_grant' on its CHECK;
//   - pull.bonus_bp (the bonus share of a sell-back) and sources 'gift' /
//     'bonus' on pull_source_check;
//   - the pack_gift table;
//   - entity 'pack_gift' and actions 'grant_pack_gift', 'revoke_pack_gift',
//     'grant_bonus_credit' on the admin_action_audit CHECKs.
// Hand-written — db:generate re-emits unrelated snapshot drift; only these
// columns and the table were added to .snapshot-packs.json.
//
// Additive: old code ignores the new columns (bonus_cents NULL reads as 0,
// bonus_bp defaults 0), so DEPLOY ORDER is the usual migrate-then-serve.

// NOT exported: the migration loader takes a migration file's first export as
// its class. migrations/__tests__/admin-audit-config-enums.unit.spec.ts and
// vault-packs-bonus.unit.spec.ts read the lists back out of the emitted SQL.
const REASONS_BEFORE = [
  'buyback',
  'topup',
  'pack_open',
  'adjustment',
  'cashout',
  'voucher_claim',
  'reward_credit',
  'daily_reward',
  'referral_commission',
  'delivery_fee',
];
const REASONS_AFTER = [...REASONS_BEFORE, 'bonus_grant'];

const SOURCES_BEFORE = ['pack', 'reward', 'free'];
const SOURCES_AFTER = [...SOURCES_BEFORE, 'gift', 'bonus'];

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
];
const ENTITY_TYPES_AFTER = [...ENTITY_TYPES_BEFORE, 'pack_gift'];

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
const ACTIONS_AFTER = [
  ...ACTIONS_BEFORE,
  'grant_pack_gift',
  'revoke_pack_gift',
  'grant_bonus_credit',
];

const inList = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export class Migration20261007120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "credit_transaction" add column if not exists "bonus_cents" integer null;`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in (${inList(REASONS_AFTER)}));`,
    );

    this.addSql(
      `alter table if exists "pull" add column if not exists "bonus_bp" integer not null default 0;`,
    );
    this.addSql(
      `alter table if exists "pull" drop constraint if exists "pull_source_check";`,
    );
    this.addSql(
      `alter table if exists "pull" add constraint "pull_source_check" check("source" in (${inList(SOURCES_AFTER)}));`,
    );

    this.addSql(
      `create table if not exists "pack_gift" ("id" text not null, "customer_id" text not null, "pack_id" text not null, "value_myr" numeric not null, "raw_value_myr" jsonb not null, "note" text not null, "granted_by" text not null, "grant_key" text not null, "open_id" text null, "pull_id" text null, "opened_at" timestamptz null, "revoked_at" timestamptz null, "revoked_by" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "pack_gift_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pack_gift_deleted_at" ON "pack_gift" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pack_gift_customer_pack" ON "pack_gift" ("customer_id", "pack_id", "created_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pack_gift_grant_key" ON "pack_gift" ("grant_key") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pack_gift_open_id" ON "pack_gift" ("open_id") WHERE deleted_at IS NULL;`,
    );

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
    // Narrowing a CHECK fails against rows that use the new values, and
    // dropping bonus_cents would silently make spend-only credit withdrawable
    // — refuse while any of that exists.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM credit_transaction WHERE reason = 'bonus_grant' OR COALESCE(bonus_cents, 0) <> 0)
           OR EXISTS (SELECT 1 FROM pull WHERE source IN ('gift', 'bonus'))
           OR EXISTS (SELECT 1 FROM pack_gift)
           OR EXISTS (SELECT 1 FROM admin_action_audit WHERE entity_type = 'pack_gift' OR action IN ('grant_pack_gift', 'revoke_pack_gift', 'grant_bonus_credit'))
        THEN
          RAISE EXCEPTION 'bonus credit or pack gifts are in use; refusing to unwind Migration20261007120000';
        END IF;
      END $$;`);
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in (${inList(ACTIONS_BEFORE)}));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in (${inList(ENTITY_TYPES_BEFORE)}));`,
    );
    this.addSql(`drop table if exists "pack_gift" cascade;`);
    this.addSql(
      `alter table if exists "pull" drop constraint if exists "pull_source_check";`,
    );
    this.addSql(
      `alter table if exists "pull" add constraint "pull_source_check" check("source" in (${inList(SOURCES_BEFORE)}));`,
    );
    this.addSql(
      `alter table if exists "pull" drop column if exists "bonus_bp";`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in (${inList(REASONS_BEFORE)}));`,
    );
    this.addSql(
      `alter table if exists "credit_transaction" drop column if exists "bonus_cents";`,
    );
  }
}
