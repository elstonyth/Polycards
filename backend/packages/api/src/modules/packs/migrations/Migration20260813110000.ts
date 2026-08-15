import { Migration } from '@mikro-orm/migrations';

// Adds the 'delete_account' audit action for customer self-service deletion.
//
// Reuses admin_action_audit rather than adding a customer-side table: the row
// shape (actor, entity, before/after, reason) is already exactly right, and
// GET /admin/customers/:id/audit — which support reads when a customer asks
// what happened — then shows the deletion in the same timeline as everything
// else. The only stretch is that `admin_id` carries a customer id here; the
// action name makes that unambiguous.
export class Migration20260813110000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check ("action" in ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_daily_reward_settings','edit_daily_box','edit_voucher_ladder','edit_fx_rate','edit_site_settings','edit_avatar_frames','replace','edit','bulk_status','disable','enable','create','reveal','delete_account'));`,
    );
  }

  // No-op for the same reason Migration20260812000000's down() is: narrowing
  // the constraint again would mean deleting the delete_account rows, and those
  // rows ARE the record of an irreversible action. The widened constraint is a
  // superset, so leaving it is harmless.
  override async down(): Promise<void> {}
}
