import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// One pull counted toward its weekly task, a support exception requested
// 2026-11-02. It is already sold, so its hold was settled at sell time and no
// value moves. The customer is named by hash because this repo is public.
//
// Data only, idempotent, a no-op if the row is already 'pack'.
export class Migration20261102180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `update "pull" set "source" = 'pack' where md5("customer_id") = 'a03a6abb22e9bd082aed815571e58eb9' and "card_id" = 'magikarp-80-psa-10-4947437' and "source" in ('bonus', 'reward', 'gift') and "status" = 'bought_back' and "created_at" >= '2026-11-02T07:00:00Z' and "created_at" < '2026-11-02T10:30:00Z' and "deleted_at" is null;`,
    );
  }

  // Nothing to undo: the source only decides what this one sold pull counts for.
  override async down(): Promise<void> {}
}
