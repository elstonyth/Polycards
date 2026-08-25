import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260825115049 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`);

    this.addSql(`alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in ('buyback', 'topup', 'pack_open', 'adjustment', 'cashout', 'voucher_claim', 'reward_credit', 'daily_reward', 'delivery_fee'));`);

    this.addSql(`alter table if exists "delivery_order" add column if not exists "insurance_fee" numeric null, add column if not exists "raw_insurance_fee" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "credit_transaction" drop constraint if exists "credit_transaction_reason_check";`);

    this.addSql(`alter table if exists "credit_transaction" add constraint "credit_transaction_reason_check" check("reason" in ('buyback', 'topup', 'pack_open', 'adjustment', 'cashout', 'voucher_claim', 'reward_credit', 'daily_reward'));`);

    this.addSql(`alter table if exists "delivery_order" drop column if exists "insurance_fee", drop column if exists "raw_insurance_fee";`);
  }

}
