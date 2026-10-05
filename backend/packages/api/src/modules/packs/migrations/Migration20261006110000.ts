import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Storefront announcement popup (spec 2026-10-06 §5): the `announcement`
// table, and entity_type 'announcement' on the admin_action_audit CHECK (its
// writes are audited). Hand-written — db:generate re-emits unrelated snapshot
// drift; only this table was added to .snapshot-packs.json.
//
// DEPLOY ORDER: run this before the new code serves traffic. Without the
// widened CHECK every announcement save fails its audit insert and rolls back.

// NOT exported: the migration loader takes a migration file's first export as
// its class. migrations/__tests__/admin-audit-config-enums.unit.spec.ts reads
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
  'pack',
  'card',
];
const ENTITY_TYPES_AFTER = [...ENTITY_TYPES_BEFORE, 'announcement'];

// Unchanged by this migration — re-emitted so the CHECK pair stays a full,
// current statement of both lists (the pin test reads both from here).
const ACTIONS = [
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

const inList = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export class Migration20261006110000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "announcement" ("id" text not null, "image_url" text not null, "title" text null, "link_url" text null, "active" boolean not null default true, "sort" integer not null default 0, "starts_at" timestamptz null, "ends_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "announcement_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_announcement_deleted_at" ON "announcement" ("deleted_at") WHERE deleted_at IS NULL;`,
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
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in (${inList(ACTIONS)}));`,
    );
  }

  override async down(): Promise<void> {
    // Narrowing the CHECK would fail against announcement audit rows, and
    // dropping the table would orphan them — refuse while any exist.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM admin_action_audit WHERE entity_type = 'announcement'
        ) THEN
          RAISE EXCEPTION 'admin_action_audit holds announcement rows; refusing to unwind the announcement migration';
        END IF;
      END $$;`);
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check("entity_type" in (${inList(ENTITY_TYPES_BEFORE)}));`,
    );
    this.addSql(`drop table if exists "announcement" cascade;`);
  }
}
