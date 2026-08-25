import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// customer_account_state.phone_verified_at — the persisted half of phone
// verification (the OTP proof tokens are stateless and expire in 10 minutes).
// requirePhoneVerified reads it to gate topup + delivery requests.
//
// Backfills NOTHING on purpose: every existing account is unverified until it
// completes the SMS flow, which is the enforcement the operator asked for. A
// backfill from customer.phone would silently trust numbers written before
// PHONE_VERIFICATION_REQUIRED was flipped on — i.e. never proven.
export class Migration20260804000010 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_account_state" add column if not exists "phone_verified_at" timestamptz null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_account_state" drop column if exists "phone_verified_at";`,
    );
  }
}
