import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Payout numbers banned for good (owner, 2026-11-03): the banks the farm rings
// shared. Filled on production only, never from the repo, which is public.
// `account_key` is payoutAccountKey's output (digits without leading zeros, or a
// wallet address whole), so one row bans the number at every bank. Not a model:
// raw SQL reads it (payoutAccountBanned), same as the expression index in
// Migration20261103190000.
export class Migration20261103230000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "banned_payout_account" ("account_key" text not null primary key, "bank_code" text null, "reason" text null, "created_at" timestamptz not null default now());`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "banned_payout_account";`);
  }
}
