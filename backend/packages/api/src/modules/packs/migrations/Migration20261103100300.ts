import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// One settled win per round. Alone in its transaction: the build blocks writes to
// credit_transaction while it scans the table, so that must end with the build.
export class Migration20261103100300 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`create unique index if not exists "IDX_credit_coin_flip_round" on "credit_transaction" ("source_transaction_id") where reason = 'coin_flip_win' and deleted_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "IDX_credit_coin_flip_round";');
  }
}
