import { Migration } from '@medusajs/framework/mikro-orm/migrations';

export class Migration20260624221128 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`,
    );

    this.addSql(
      `alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in ('buyback', 'topup', 'pack_open', 'adjustment', 'direct_referral', 'team_override', 'commission_reversal', 'cashout', 'voucher_claim', 'reward_credit'));`,
    );
  }

  override async down(): Promise<void> {
    // Refuse to narrow the reason CHECK if any financial-history rows use the
    // values being removed — deleting ledger rows would destroy money history.
    // (Same refuse-guard pattern as the admin_action_audit / reward_pool down().)
    this.addSql(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "credit_transaction" WHERE reason IN ('voucher_claim','reward_credit')) THEN
        RAISE EXCEPTION 'refusing to narrow credit_transaction reason: voucher_claim/reward_credit rows exist';
      END IF;
    END $$;`);

    this.addSql(
      `alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`,
    );

    this.addSql(
      `alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in ('buyback', 'topup', 'pack_open', 'adjustment', 'direct_referral', 'team_override', 'commission_reversal', 'cashout'));`,
    );
  }
}
