import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Transaction ledger (POLYCARD-BACK §5): two new tables, no changes to any
// existing table. Pure additive — expand-safe, no backfill (D4). Both money
// columns on ledger_entry are bigNumber, so each gets its raw_<field> jsonb
// sidecar (the trap: a migration that forgets this half passes every mocked
// test and fails on the first real insert — see Global Constraints).
export class Migration20260728210000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "ledger_entry" (` +
        `"id" text not null, ` +
        `"display_id" text not null, ` +
        `"type" text check ("type" in ('TP','SP','SE','OD','RF','AD','WP')) not null, ` +
        `"customer_id" text not null, ` +
        `"occurred_at" timestamptz not null, ` +
        `"wallet_delta" numeric null, ` +
        `"raw_wallet_delta" jsonb null, ` +
        `"vault_delta" numeric null, ` +
        `"raw_vault_delta" jsonb null, ` +
        `"payload" jsonb null, ` +
        `"ref_id" text not null, ` +
        `"created_at" timestamptz not null default now(), ` +
        `"updated_at" timestamptz not null default now(), ` +
        `"deleted_at" timestamptz null, ` +
        `constraint "ledger_entry_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ledger_entry_display_id_unique" ON "ledger_entry" ("display_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ledger_entry_type_ref_id" ON "ledger_entry" ("type", "ref_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ledger_entry_customer_id_occurred_at" ON "ledger_entry" ("customer_id", "occurred_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ledger_entry_type_occurred_at" ON "ledger_entry" ("type", "occurred_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `create table if not exists "ledger_sequence" (` +
        `"id" text not null, ` +
        `"scope" text not null, ` +
        `"last_serial" text null, ` +
        `"created_at" timestamptz not null default now(), ` +
        `"updated_at" timestamptz not null default now(), ` +
        `"deleted_at" timestamptz null, ` +
        `constraint "ledger_sequence_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ledger_sequence_scope_unique" ON "ledger_sequence" ("scope") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "ledger_sequence" cascade;`);
    this.addSql(`drop table if exists "ledger_entry" cascade;`);
  }
}
