import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Lucky Draw (spec 2026-10-24): five new tables and task_definition.tickets.
// Purely additive — old code never reads any of it, so DEPLOY ORDER is the
// usual migrate-then-serve and a rollback only has to drop what is added here.
//
// Hand-written (the generator re-emits unrelated snapshot drift), in the shape
// `db:generate` would produce: enums are inline CHECKs, and the nullable
// bigNumber credit_myr ships with its raw_credit_myr jsonb twin.
export class Migration20261024120000 extends Migration {
  override async up(): Promise<void> {
    // Fail the deploy fast rather than queue task reads behind the ALTER lock.
    this.addSql(`set local lock_timeout = '5s';`);

    this.addSql(
      `alter table if exists "task_definition" add column if not exists "tickets" integer not null default 0;`,
    );

    this.addSql(
      `create table if not exists "lucky_draw_event" ("id" text not null, "name" text not null, "starts_at" timestamptz not null, "ends_at" timestamptz not null, "status" text check ("status" in ('draft', 'published', 'cancelled')) not null default 'draft', "created_by" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lucky_draw_event_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_event_deleted_at" ON "lucky_draw_event" ("deleted_at") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "lucky_draw_prize" ("id" text not null, "event_id" text not null, "kind" text check ("kind" in ('card', 'credit')) not null, "card_handle" text null, "credit_myr" numeric null, "title" text not null, "image_url" text null, "sort" integer not null default 0, "draw_at" timestamptz not null, "seed_nonce" text null, "seed_hash" text null, "cancelled_at" timestamptz null, "raw_credit_myr" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lucky_draw_prize_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_prize_deleted_at" ON "lucky_draw_prize" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_prize_event" ON "lucky_draw_prize" ("event_id") WHERE deleted_at IS NULL;`,
    );
    // The draw job's read: prizes still waiting for their draw.
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_prize_draw_at" ON "lucky_draw_prize" ("draw_at") WHERE cancelled_at IS NULL AND deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "lucky_draw_entry" ("id" text not null, "prize_id" text not null, "customer_id" text not null, "tickets" integer not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lucky_draw_entry_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_entry_deleted_at" ON "lucky_draw_entry" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_entry_prize" ON "lucky_draw_entry" ("prize_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_entry_customer" ON "lucky_draw_entry" ("customer_id") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "lucky_draw_ticket" ("id" text not null, "customer_id" text not null, "delta" integer not null, "reason" text check ("reason" in ('task_claim', 'entry', 'refund')) not null, "ref" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lucky_draw_ticket_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_ticket_deleted_at" ON "lucky_draw_ticket" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_ticket_customer" ON "lucky_draw_ticket" ("customer_id") WHERE deleted_at IS NULL;`,
    );
    // A replayed claim / entry / refund collides here instead of double-counting.
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lucky_draw_ticket_reason_ref" ON "lucky_draw_ticket" ("reason", "ref") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "lucky_draw_result" ("id" text not null, "prize_id" text not null, "winner_customer_id" text null, "winner_tickets" integer not null default 0, "total_tickets" integer not null default 0, "entrant_count" integer not null default 0, "ticket_index" integer null, "seed" text not null, "entries" jsonb not null, "excluded" jsonb not null, "credit_transaction_id" text null, "pull_id" text null, "drawn_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lucky_draw_result_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_result_deleted_at" ON "lucky_draw_result" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    // One result per prize: the backstop under the draw's advisory lock.
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lucky_draw_result_prize" ON "lucky_draw_result" ("prize_id") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "lucky_draw_result" cascade;`);
    this.addSql(`drop table if exists "lucky_draw_ticket" cascade;`);
    this.addSql(`drop table if exists "lucky_draw_entry" cascade;`);
    this.addSql(`drop table if exists "lucky_draw_prize" cascade;`);
    this.addSql(`drop table if exists "lucky_draw_event" cascade;`);
    this.addSql(
      `alter table if exists "task_definition" drop column if exists "tickets";`,
    );
  }
}
