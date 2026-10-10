import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// vip_member_state.vip_reset_at — the operator VIP reset cutoff
// (resetVipLevel). The VIP basis counts only pack opens after it. Hand-written;
// only this column was added to .snapshot-packs.json.
//
// Additive: old code ignores the column, so DEPLOY ORDER is the usual
// migrate-then-serve. No customer is reset here; that is an ops action.
export class Migration20261008120000 extends Migration {
  override async up(): Promise<void> {
    // Every open upserts this table: fail the deploy fast rather than queue
    // opens behind the ALTER's lock.
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `alter table if exists "vip_member_state" add column if not exists "vip_reset_at" timestamptz null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "vip_member_state" drop column if exists "vip_reset_at";`,
    );
  }
}
