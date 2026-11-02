import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// One-winner Lucky Draw (spec 2026-10-30): an event gets a draw_mode and its own
// seed commitment, an entry can point at the event instead of a prize, and the
// new lucky_draw_event_result table holds one proof per event.
//
// Purely additive for old rows: every existing event defaults to 'per_prize',
// every existing entry already has a prize_id and a null event_id, so the CHECK
// passes without touching them. IDX_lucky_draw_entry_prize is not unique, and
// every read through it filters on prize_id, so a null there is simply not in
// any prize's draw. Old code keeps working until a one_winner event exists,
// which only new code can create. DEPLOY ORDER is the usual migrate-then-serve.
//
// Hand-written (the generator re-emits unrelated snapshot drift).
export class Migration20261030110000 extends Migration {
  override async up(): Promise<void> {
    // Fail the deploy fast rather than queue entries behind the ALTER lock: the
    // new CHECK scans lucky_draw_entry while holding it.
    this.addSql(`set local lock_timeout = '5s';`);

    this.addSql(
      `alter table if exists "lucky_draw_event" add column if not exists "draw_mode" text check ("draw_mode" in ('per_prize', 'one_winner')) not null default 'per_prize';`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_event" add column if not exists "seed_nonce" text null;`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_event" add column if not exists "seed_hash" text null;`,
    );

    this.addSql(
      `alter table if exists "lucky_draw_entry" add column if not exists "event_id" text null;`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_entry" alter column "prize_id" drop not null;`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_entry" drop constraint if exists "lucky_draw_entry_one_target_check";`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_entry" add constraint "lucky_draw_entry_one_target_check" check (num_nonnulls("prize_id", "event_id") = 1);`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_entry_event" ON "lucky_draw_entry" ("event_id") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "lucky_draw_event_result" ("id" text not null, "event_id" text not null, "winner_customer_id" text null, "winner_tickets" integer not null default 0, "total_tickets" integer not null default 0, "entrant_count" integer not null default 0, "ticket_index" integer null, "seed" text not null, "entries" jsonb not null, "excluded" jsonb not null, "drawn_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lucky_draw_event_result_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_lucky_draw_event_result_deleted_at" ON "lucky_draw_event_result" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    // One result per event: the backstop under the draw's advisory lock.
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lucky_draw_event_result_event" ON "lucky_draw_event_result" ("event_id") WHERE deleted_at IS NULL;`,
    );
  }

  // An entry on an event cannot go back under a NOT NULL prize_id, and a
  // one_winner event would read as a per_prize event with no seeds: refuse while
  // either exists. Soft-deleted rows count, because the NOT NULL covers them too.
  override async down(): Promise<void> {
    this.addSql(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM lucky_draw_entry WHERE prize_id IS NULL)
          OR EXISTS (SELECT 1 FROM lucky_draw_event WHERE draw_mode = 'one_winner')
        THEN
          RAISE EXCEPTION 'one_winner events or entries exist; refusing to unwind Migration20261030110000';
        END IF;
      END $$;`);
    this.addSql(`drop table if exists "lucky_draw_event_result" cascade;`);
    this.addSql(`drop index if exists "IDX_lucky_draw_entry_event";`);
    this.addSql(
      `alter table if exists "lucky_draw_entry" drop constraint if exists "lucky_draw_entry_one_target_check";`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_entry" alter column "prize_id" set not null;`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_entry" drop column if exists "event_id";`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_event" drop column if exists "seed_hash";`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_event" drop column if exists "seed_nonce";`,
    );
    this.addSql(
      `alter table if exists "lucky_draw_event" drop column if exists "draw_mode";`,
    );
  }
}
