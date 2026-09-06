import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// GlobePay365 retired 2026-09-06: TGPay is the only gateway. The orchestration
// stamps every new row's gateway explicitly, so this default is a safety net
// for any other writer — a raw insert must not mint a row under a retired
// gateway that no sweep will ever call. Existing rows are untouched: their
// 'globepay' value is exactly the history the audit panel reports.
export class Migration20260906100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "globepay_deposit" alter column "gateway" set default 'tgpay';`,
    );
    this.addSql(
      `alter table if exists "globepay_withdrawal" alter column "gateway" set default 'tgpay';`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "globepay_deposit" alter column "gateway" set default 'globepay';`,
    );
    this.addSql(
      `alter table if exists "globepay_withdrawal" alter column "gateway" set default 'globepay';`,
    );
  }
}
