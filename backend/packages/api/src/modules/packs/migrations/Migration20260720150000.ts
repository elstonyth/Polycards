import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Index the notification unread-count path. GET /store/notifications is the
// highest-frequency authenticated query (bell polls it on every SPA nav +
// window focus). Its notification_read count filters by customer_id alone, but
// the model's only index is the composite unique (notification_id, customer_id)
// whose leading column is absent from the predicate — so Postgres seq-scans a
// table that grows with every "mark read" forever. This adds the missing
// single-column index. (Part B — the core `notification` table's receiver_id
// index — was verified already present, so no index is added for it here.)
export class Migration20260720150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_read_customer_id" ON "notification_read" ("customer_id") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_notification_read_customer_id";`);
  }
}
