import { Migration } from '@mikro-orm/migrations';

// Adds the 'reveal' admin action.
//
// A REVEAL is an audit event in its own right: GET
// /admin/customers/:id/payout-details returns the FULL bank account number, and
// until now it left no trace at all while the corresponding write was both
// throttled and audited. Enumerating customer ids therefore harvested every
// stored bank number invisibly. Reusing 'edit' would have been wrong — it would
// pollute the edit history with reads and make a real change indistinguishable
// from a look.
export class Migration20260812000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check ("action" in ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_daily_reward_settings','edit_daily_box','edit_voucher_ladder','edit_fx_rate','edit_site_settings','edit_avatar_frames','replace','edit','bulk_status','disable','enable','create','reveal'));`,
    );
  }

  // Deliberately a NO-OP. Restoring the narrower constraint means first
  // deleting every row with action = 'reveal', and those rows ARE the audit
  // trail of who unmasked a customer's payout details — the whole point of the
  // migration. A rollback must never be the thing that erases security
  // evidence, and "the schema change is reversible" is not worth that.
  //
  // Leaving the widened constraint in place is harmless: it is a SUPERSET of
  // the old one, so every value the old schema permitted is still permitted,
  // and nothing writes 'reveal' once the route is rolled back.
  override async down(): Promise<void> {}
}
