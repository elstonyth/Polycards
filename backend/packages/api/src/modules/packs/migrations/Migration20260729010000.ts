import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Purchase Invoices + Inventory audit log (POLYCARD-BACK §3.1). Three new
// tables, additive; widens admin_action_audit for the invoice-create audit
// row (entity_type 'purchase_invoice', action 'create'). purchase_invoice_seq
// is a real Postgres sequence — atomic under concurrency, immune to
// transaction rollback, backing display_no's "PI-00001" format.
//
// NOTE: the brief specified Migration20260729000000, but that name is already
// taken by feat/odds-autosplit (pack.target_rtp_bps) — MikroORM keys applied
// migrations by NAME, so a collision means one of the two silently never runs.
// Bumped to the next free hour slot.
export class Migration20260729010000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "purchase_invoice" ("id" text not null, "display_no" text not null, "date" timestamptz not null, "supplier" text not null, "agent_user_id" text not null, "reverses_invoice_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "purchase_invoice_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_purchase_invoice_display_no_unique" ON "purchase_invoice" ("display_no") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_purchase_invoice_created_at" ON "purchase_invoice" ("created_at") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "purchase_invoice_line" ("id" text not null, "invoice_id" text not null, "card_handle" text not null, "card_name" text not null, "fmv_snapshot" numeric not null, "raw_fmv_snapshot" jsonb not null, "qty" integer not null, "unit_cost" numeric not null, "raw_unit_cost" jsonb not null, "line_total" numeric not null, "raw_line_total" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "purchase_invoice_line_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_purchase_invoice_line_invoice_id" ON "purchase_invoice_line" ("invoice_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_purchase_invoice_line_card_handle" ON "purchase_invoice_line" ("card_handle") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "stock_movement" ("id" text not null, "card_handle" text not null, "kind" text check ("kind" in ('purchase','pull','vault_out','requested','shipped','completed','adjustment')) not null, "qty" integer not null, "ref_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "stock_movement_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_stock_movement_card_handle_created_at" ON "stock_movement" ("card_handle","created_at") WHERE deleted_at IS NULL;`,
    );

    this.addSql(`CREATE SEQUENCE IF NOT EXISTS "purchase_invoice_seq" START 1;`);

    // admin_action_audit: widen BOTH check constraints with the current full
    // value list (from models/admin-action-audit.ts, post Epics 1-3) plus the
    // two new values — same drop/re-add pattern as Migration20260727000001.
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check ("entity_type" in ('customer','commission','rewards_settings','credit','reward_pool','daily_reward_settings','daily_box','voucher_ladder','fx','site_settings','vip_levels','challenge_stages','challenge_settings','delivery_order','purchase_invoice'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check ("action" in ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_daily_reward_settings','edit_daily_box','edit_voucher_ladder','edit_fx_rate','edit_site_settings','edit_avatar_frames','replace','edit','bulk_status','disable','enable','create'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `delete from "admin_action_audit" where "entity_type" = 'purchase_invoice' or "action" = 'create';`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_entity_type_check" check ("entity_type" in ('customer','commission','rewards_settings','credit','reward_pool','daily_reward_settings','daily_box','voucher_ladder','fx','site_settings','vip_levels','challenge_stages','challenge_settings','delivery_order'));`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check ("action" in ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_daily_reward_settings','edit_daily_box','edit_voucher_ladder','edit_fx_rate','edit_site_settings','edit_avatar_frames','replace','edit','bulk_status','disable','enable'));`,
    );
    this.addSql(`DROP SEQUENCE IF EXISTS "purchase_invoice_seq";`);
    // Purchase/stock records are operator financial history — refuse to drop
    // live rows (same guard shape as Migration20260623000000's
    // admin_action_audit/customer_account_state down()).
    this.addSql(
      `DO $$ BEGIN IF EXISTS (SELECT 1 FROM "purchase_invoice" WHERE deleted_at IS NULL) THEN RAISE EXCEPTION 'refusing to drop purchase_invoice: % live rows exist', (SELECT count(*) FROM "purchase_invoice" WHERE deleted_at IS NULL); END IF; END $$;`,
    );
    this.addSql(`drop table if exists "stock_movement" cascade;`);
    this.addSql(`drop table if exists "purchase_invoice_line" cascade;`);
    this.addSql(`drop table if exists "purchase_invoice" cascade;`);
  }
}
