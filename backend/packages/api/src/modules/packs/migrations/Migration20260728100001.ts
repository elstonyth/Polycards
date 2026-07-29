import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Manual-cashout bank destination per customer (POLYCARD-BACK §4.3). New table
// only — expand-safe. Partial unique index (not a plain unique constraint) so
// it matches what MikroORM derives from `customer_id: model.text().unique()`
// with soft deletes, mirroring customer_account_state.
export class Migration20260728100001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "player_payout_details" ("id" text not null, "customer_id" text not null, "bank_name" text not null, "bank_account_number" text not null, "account_holder_name" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "player_payout_details_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_player_payout_details_customer_id_unique" ON "player_payout_details" ("customer_id") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    // Payout destinations are operator records — refuse to drop live rows.
    this.addSql(
      `DO $$ BEGIN IF EXISTS (SELECT 1 FROM "player_payout_details" WHERE deleted_at IS NULL) THEN RAISE EXCEPTION 'refusing to drop player_payout_details: % live rows exist', (SELECT count(*) FROM "player_payout_details" WHERE deleted_at IS NULL); END IF; END $$;`,
    );
    this.addSql(`drop table if exists "player_payout_details" cascade;`);
  }
}
