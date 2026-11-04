import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Indexes `metadata.handle_alias`: an old profile handle kept after a one-off
// move, so the old /profile/<handle> link still finds its player. Unique like
// a handle, and case folded the same way. Nothing writes the key yet; the
// 8-digit "Collector########" backfill that does ships in a LATER deploy, so
// that every running pod already treats aliases as taken (claimUsername,
// claimHandle, the username guard) and resolves them (findCustomerIdByHandle)
// before the first alias exists. Shipped together, a pod still on the old
// code during the pre-deploy migrate could hand a freshly retired handle to
// someone else.
//
// The expression must stay byte-for-byte what those queries use, or Postgres
// cannot use the index. Partial on deleted_at like the handle index: account
// deletion empties the blob.
export class Migration20261104110000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create unique index if not exists "IDX_customer_handle_alias_lower_unique"
        on "customer" (lower(metadata->>'handle_alias'))
        where "deleted_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop index if exists "IDX_customer_handle_alias_lower_unique";',
    );
  }
}
