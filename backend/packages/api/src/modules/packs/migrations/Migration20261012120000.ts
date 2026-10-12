import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// A3Pay (SGD) behind the RM ledger: the FX spread on fx_rate, and the FX lock
// on every gateway_deposit / gateway_withdrawal row (payment-fx.ts).
//
// Additive only. Existing rows are RM rows: currency defaults to 'MYR' and the
// lock columns stay NULL, which payment-fx.ts reads as "convert 1:1".
//
// bigNumber is TWO physical columns — the numeric one and its raw_<field>
// jsonb sidecar the ORM reads back (see Migration20260817090000 for what
// adding only the numeric half does on the first real insert).
export class Migration20261012120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "fx_rate"
      add column if not exists "markup" numeric not null default 0,
      add column if not exists "raw_markup" jsonb not null default '{"value":"0","precision":20}';`);

    for (const table of ['gateway_deposit', 'gateway_withdrawal']) {
      this.addSql(`alter table if exists "${table}"
        add column if not exists "currency" text not null default 'MYR',
        add column if not exists "gateway_amount" numeric null,
        add column if not exists "raw_gateway_amount" jsonb null,
        add column if not exists "fx_mid" numeric null,
        add column if not exists "raw_fx_mid" jsonb null,
        add column if not exists "fx_markup" numeric null,
        add column if not exists "raw_fx_markup" jsonb null;`);
    }
  }

  override async down(): Promise<void> {
    for (const table of ['gateway_deposit', 'gateway_withdrawal']) {
      this.addSql(`alter table if exists "${table}"
        drop column if exists "currency",
        drop column if exists "gateway_amount",
        drop column if exists "raw_gateway_amount",
        drop column if exists "fx_mid",
        drop column if exists "raw_fx_mid",
        drop column if exists "fx_markup",
        drop column if exists "raw_fx_markup";`);
    }
    this.addSql(`alter table if exists "fx_rate"
      drop column if exists "markup",
      drop column if exists "raw_markup";`);
  }
}
