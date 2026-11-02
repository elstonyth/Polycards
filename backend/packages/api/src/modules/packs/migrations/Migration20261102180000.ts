import { Migration } from '@medusajs/framework/mikro-orm/migrations';

const THIS_PULL = `md5("customer_id") = 'a03a6abb22e9bd082aed815571e58eb9' and "card_id" = 'magikarp-80-psa-10-4947437' and "status" = 'bought_back' and "created_at" >= '2026-11-02T07:00:00Z' and "created_at" < '2026-11-02T10:30:00Z' and "deleted_at" is null`;

// One pull counted toward its weekly task, a support exception requested
// 2026-11-02. It is already sold, so its hold was settled at sell time and no
// money moves. A bonus-paid row already counts on the boards. A free rip or gift
// doesn't, so its value is zeroed: 'pack' would otherwise add the card's worth
// to the leaderboard and challenge, whose ranks pay prizes. The customer is named
// by hash because this repo is public.
//
// Data only, idempotent, a no-op if the row is already 'pack'.
export class Migration20261102180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `update "pull" set "source" = 'pack' where "source" = 'bonus' and ${THIS_PULL};`,
    );
    this.addSql(
      `update "pull" set "source" = 'pack', "recorded_value_usd" = 0, "raw_recorded_value_usd" = '{"value":"0","precision":20}' where "source" in ('reward', 'gift') and ${THIS_PULL};`,
    );
  }

  // Nothing to undo: this only decides what one sold pull counts for.
  override async down(): Promise<void> {}
}
