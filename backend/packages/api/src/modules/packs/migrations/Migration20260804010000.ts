import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// challenge_schedule — the queue of Weekly Challenges waiting to go live.
// See models/challenge-schedule.ts for why the stage ladder is one json column
// instead of a second stage table.
export class Migration20260804010000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "challenge_schedule" (
      "id" text not null,
      "starts_at" timestamptz not null,
      "label" text null,
      "stages" jsonb not null,
      "applied_at" timestamptz null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      "deleted_at" timestamptz null,
      constraint "challenge_schedule_pkey" primary key ("id")
    );`);
    // Partial index matching the promotion query (due, unapplied, live).
    this.addSql(
      `create index if not exists "IDX_challenge_schedule_pending" on "challenge_schedule" ("starts_at") where applied_at is null and deleted_at is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "challenge_schedule" cascade;`);
  }
}
