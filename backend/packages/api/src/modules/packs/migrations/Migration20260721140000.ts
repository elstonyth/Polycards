import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// globepay_deposit — outstanding/settled GlobePay365 deposits. See
// models/globepay-deposit.ts for why the table is required: their deposit
// callback echoes MerchantTransactionId but not MerchantClientId, so without a
// row written at SubmitDeposit there is no customer to credit.
//
// Additive and forward-only: no existing table is touched, so this is safe to
// deploy before the gateway is switched on.
export class Migration20260721140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "globepay_deposit" (
        "id" text not null,
        "merchant_transaction_id" text not null,
        "gateway_transaction_id" text null,
        "customer_id" text not null,
        -- model.bigNumber() is TWO columns: the numeric for querying and a
        -- raw_* jsonb holding the arbitrary-precision value. Omitting the
        -- raw_* column compiles and passes mocked tests, then fails at the
        -- first real insert with 'column "raw_amount_requested" does not
        -- exist'. Matches credit_transaction.amount / raw_amount.
        "amount_requested" numeric not null,
        "raw_amount_requested" jsonb not null,
        "amount_settled" numeric null,
        "raw_amount_settled" jsonb null,
        "payment_method_code" text not null,
        "status" text check ("status" in ('pending', 'settled', 'failed')) not null default 'pending',
        "gateway_status" integer null,
        "settled_at" timestamptz null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "globepay_deposit_pkey" primary key ("id")
      );
    `);
    // Our reference must be unique — their PMT10000 rejects a duplicate, and we
    // would rather fail before the network call than after it.
    this.addSql(
      `create unique index if not exists "IDX_globepay_deposit_merchant_transaction_id" on "globepay_deposit" ("merchant_transaction_id") where "deleted_at" is null;`,
    );
    // Every callback looks the row up by THEIR id once it is known.
    this.addSql(
      `create index if not exists "IDX_globepay_deposit_gateway_transaction_id" on "globepay_deposit" ("gateway_transaction_id") where "deleted_at" is null;`,
    );
    // Reconciliation sweep: outstanding deposits, oldest first.
    this.addSql(
      `create index if not exists "IDX_globepay_deposit_status_created_at" on "globepay_deposit" ("status", "created_at") where "deleted_at" is null;`,
    );
    this.addSql(
      `create index if not exists "IDX_globepay_deposit_customer_id" on "globepay_deposit" ("customer_id") where "deleted_at" is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "globepay_deposit" cascade;`);
  }
}
