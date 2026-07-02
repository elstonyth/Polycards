import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// card_price_history only. The generator also emitted fx_rate/card drift
// statements (tables + columns that already exist in the live DB); those were
// hand-trimmed — their down() would have dropped live tables.
export class Migration20260702111423 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "card_price_history" ("id" text not null, "card_id" text not null, "value" numeric not null, "raw_value" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "card_price_history_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_card_price_history_deleted_at" ON "card_price_history" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_card_price_history_card_id" ON "card_price_history" ("card_id") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "card_price_history" cascade;`);
  }
}
