import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// The admin gateway switch (plan 130) writes an admin_action_audit row with
// action 'edit_payment_gateway'. The model enum gained the value with the
// switch, but the DB CHECK is only rewritten by an explicit migration, so
// without this one the audit insert violates admin_action_audit_action_check
// and rolls the whole switch back (found in review 2026-09-06 — the switch had
// only ever run against a mocked service). Same drop/re-add recipe as
// Migration20260824150000, with the full current model list.
export class Migration20260906090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in ('freeze', 'unfreeze', 'reverse_commission', 'suspend_commission', 'unsuspend_commission', 'adjust_credit', 'edit_rewards_settings', 'edit_reward_pool', 'edit_daily_reward_settings', 'edit_daily_box', 'edit_voucher_ladder', 'edit_fx_rate', 'edit_site_settings', 'edit_payment_gateway', 'edit_avatar_frames', 'replace', 'edit', 'bulk_status', 'disable', 'enable', 'create', 'reveal', 'delete_account', 'set_partner_rate', 'edit_referral_settings', 'approve_settlement', 'void_settlement_line', 'void_settlement', 'pay_settlement'));`,
    );
  }

  override async down(): Promise<void> {
    // Narrowing back would fail against any 'edit_payment_gateway' row already
    // written, so the down path re-adds the previous list only when none exist.
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM admin_action_audit WHERE action = 'edit_payment_gateway') THEN
          RAISE EXCEPTION 'admin_action_audit holds edit_payment_gateway rows; refusing to narrow the CHECK';
        END IF;
      END $$;`);
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check("action" in ('freeze', 'unfreeze', 'reverse_commission', 'suspend_commission', 'unsuspend_commission', 'adjust_credit', 'edit_rewards_settings', 'edit_reward_pool', 'edit_daily_reward_settings', 'edit_daily_box', 'edit_voucher_ladder', 'edit_fx_rate', 'edit_site_settings', 'edit_avatar_frames', 'replace', 'edit', 'bulk_status', 'disable', 'enable', 'create', 'reveal', 'delete_account', 'set_partner_rate', 'edit_referral_settings', 'approve_settlement', 'void_settlement_line', 'void_settlement', 'pay_settlement'));`,
    );
  }
}
