import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// One settled win per round. The build blocks writes to credit_transaction while
// it scans the table. NOT alone in its transaction, whatever this said before:
// the migrator runs every pending migration in one transaction (see
// Migration20261103100400), so the lock is held until the whole deploy's
// migrations commit.
export class Migration20261103100300 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`create unique index if not exists "IDX_credit_coin_flip_round" on "credit_transaction" ("source_transaction_id") where reason = 'coin_flip_win' and deleted_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "IDX_credit_coin_flip_round";');
  }
}
