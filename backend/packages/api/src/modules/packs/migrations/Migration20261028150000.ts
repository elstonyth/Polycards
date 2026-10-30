import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Goods receive notes (spec 2026-10-28). Additive:
//  - goods_receive_note + goods_receive_note_line, and goods_receive_note_seq
//    behind display_no's "GRN-00001" (same shape as purchase_invoice_seq);
//  - one reversal per GRN (IDX_goods_receive_note_reverses_unique);
//  - purchase_invoice.from_grn_id, "transfer from goods receive note". No
//    unique index: a transfer reversed in full re-opens its GRN for a
//    corrected transfer, so one GRN can carry several invoices over time;
//    only one is live at once, enforced under the GRN's advisory lock
//    (service.lockOpenGoodsReceiveNote);
//  - stock_movement.kind gains 'goods_receive' (one row per GRN line);
//  - admin_action_audit's entity_type CHECK gains 'goods_receive_note'. Both
//    CHECK lists are re-emitted in full, as every CHECK-rewriting migration
//    does, so migrations/__tests__/admin-audit-config-enums.unit.spec.ts can
//    read them back from the latest one.
//
// Hand-written. Old code never reads or writes the new column or tables, so
// DEPLOY ORDER is the usual migrate-then-serve.

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
  'gateway_deposit',
  'lucky_draw_event',
  'lucky_draw_prize',
];
const ENTITY_TYPES_AFTER = [...ENTITY_TYPES_BEFORE, 'goods_receive_note'];
// Unchanged by this migration; re-emitted because the CHECK pair is rewritten
// together.
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
  'set_real_name',
  'set_phone',
  'grant_pack_gift',
  'revoke_pack_gift',
  'grant_bonus_credit',
  'release_reward_holds',
  'acknowledge_finding',
  'publish',
];
const KINDS_BEFORE = [
  'purchase',
  'pull',
  'vault_out',
  'requested',
  'shipped',
  'completed',
  'adjustment',
];
const KINDS_AFTER = [...KINDS_BEFORE, 'goods_receive'];

const inList = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export class Migration20261028150000 extends Migration {
  override async up(): Promise<void> {
    // Admin audit rows are written all day: fail the deploy fast rather than
    // queue them behind the ALTER's lock.
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `create table if not exists "goods_receive_note" ("id" text not null, "display_no" text not null, "date" timestamptz not null, "supplier" text not null, "agent_user_id" text not null, "reverses_grn_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "goods_receive_note_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_goods_receive_note_display_no_unique" ON "goods_receive_note" ("display_no") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_goods_receive_note_created_at" ON "goods_receive_note" ("created_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_goods_receive_note_reverses_unique" ON "goods_receive_note" ("reverses_grn_id") WHERE deleted_at IS NULL AND reverses_grn_id IS NOT NULL;`,
    );
    this.addSql(
      `create table if not exists "goods_receive_note_line" ("id" text not null, "grn_id" text not null, "card_handle" text not null, "card_name" text not null, "fmv_snapshot" numeric not null, "raw_fmv_snapshot" jsonb not null, "qty" integer not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "goods_receive_note_line_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_goods_receive_note_line_grn_id" ON "goods_receive_note_line" ("grn_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_goods_receive_note_line_card_handle" ON "goods_receive_note_line" ("card_handle") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE SEQUENCE IF NOT EXISTS "goods_receive_note_seq" START 1;`,
    );

    this.addSql(
      `alter table if exists "purchase_invoice" add column if not exists "from_grn_id" text null;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_purchase_invoice_from_grn_id" ON "purchase_invoice" ("from_grn_id") WHERE deleted_at IS NULL AND from_grn_id IS NOT NULL;`,
    );

    this.kinds(KINDS_AFTER);
    this.checks(ENTITY_TYPES_AFTER, ACTIONS);
  }

  override async down(): Promise<void> {
    // GRN rows are operator stock history, and narrowing the CHECKs fails
    // against rows that use the new values: refuse while any exists.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM goods_receive_note)
          OR EXISTS (SELECT 1 FROM purchase_invoice WHERE from_grn_id IS NOT NULL)
          OR EXISTS (SELECT 1 FROM stock_movement WHERE kind = 'goods_receive')
          OR EXISTS (SELECT 1 FROM admin_action_audit WHERE entity_type = 'goods_receive_note')
        THEN
          RAISE EXCEPTION 'goods_receive_note rows exist; refusing to unwind Migration20261028150000';
        END IF;
      END $$;`);
    this.checks(ENTITY_TYPES_BEFORE, ACTIONS);
    this.kinds(KINDS_BEFORE);
    this.addSql(`DROP INDEX IF EXISTS "IDX_purchase_invoice_from_grn_id";`);
    this.addSql(
      `alter table if exists "purchase_invoice" drop column if exists "from_grn_id";`,
    );
    this.addSql(`DROP SEQUENCE IF EXISTS "goods_receive_note_seq";`);
    this.addSql(`drop table if exists "goods_receive_note_line" cascade;`);
    this.addSql(`drop table if exists "goods_receive_note" cascade;`);
  }

  private kinds(kinds: string[]): void {
    this.addSql(
      `alter table if exists "stock_movement" drop constraint if exists "stock_movement_kind_check";`,
    );
    this.addSql(
      `alter table if exists "stock_movement" add constraint "stock_movement_kind_check" check("kind" in (${inList(kinds)}));`,
    );
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
