import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// globepay_withdrawal — outstanding/settled GlobePay365 payouts (method WD).
// Mirrors globepay_deposit; see models/globepay-withdrawal.ts. Additive and
// forward-only: safe to deploy before withdrawals are switched on.
export class Migration20260722170000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "globepay_withdrawal" (
        "id" text not null,
        "merchant_transaction_id" text not null,
        "gateway_transaction_id" text null,
        "customer_id" text not null,
        -- model.bigNumber() is TWO columns (numeric + raw_* jsonb); omitting
        -- raw_* passes every mocked test and fails on the first real insert.
        "amount" numeric not null,
        "raw_amount" jsonb not null,
        "bank_code" text not null,
        "account_number" text not null,
        "account_holder_name" text not null,
        "status" text check ("status" in ('pending', 'settled', 'failed')) not null default 'pending',
        "gateway_status" integer null,
        "settled_at" timestamptz null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "globepay_withdrawal_pkey" primary key ("id")
      );
    `);
    this.addSql(
      `create unique index if not exists "IDX_globepay_withdrawal_merchant_transaction_id" on "globepay_withdrawal" ("merchant_transaction_id") where "deleted_at" is null;`,
    );
    this.addSql(
      `create index if not exists "IDX_globepay_withdrawal_gateway_transaction_id" on "globepay_withdrawal" ("gateway_transaction_id") where "deleted_at" is null;`,
    );
    this.addSql(
      `create index if not exists "IDX_globepay_withdrawal_status_created_at" on "globepay_withdrawal" ("status", "created_at") where "deleted_at" is null;`,
    );
    this.addSql(
      `create index if not exists "IDX_globepay_withdrawal_customer_id" on "globepay_withdrawal" ("customer_id") where "deleted_at" is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "globepay_withdrawal" cascade;`);
  }
}
