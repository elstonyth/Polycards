import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Daily tasks (spec 2026-10-06): task_definition.kind gains 'daily', a third
// cadence beside weekly and achievement. The kind is an inline CHECK (the
// MikroORM enum mapping), so widening it is a constraint swap; no row
// changes. A daily task's claims key on the MYT date (tasks.ts
// taskPeriodKey), which the existing task_claim unique index already
// enforces once per day.
export class Migration20261006100000 extends Migration {
  override async up(): Promise<void> {
    // Fail the deploy fast rather than queue the /task reads behind the lock.
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `alter table if exists "task_definition" drop constraint if exists "task_definition_kind_check";`,
    );
    this.addSql(
      `alter table if exists "task_definition" add constraint "task_definition_kind_check" check ("kind" in ('daily', 'weekly', 'achievement'));`,
    );
    // When a task was switched off: bounds a retired repeating task's claims
    // to the period it was retired in (see the model). Existing inactive rows
    // stay null, which reads as "retired before now" — they were.
    this.addSql(
      `alter table if exists "task_definition" add column if not exists "retired_at" timestamptz null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "task_definition" drop column if exists "retired_at";`,
    );
    // Daily rows cannot survive a rollback: the old code keys their claims
    // once-ever and its storefront schema rejects the whole hub over one
    // unknown kind. Retire AND soft-delete them (the old reads skip
    // deleted_at rows), BEFORE the narrower CHECK goes back on. NOT VALID
    // keeps the re-add from scanning rows it would otherwise refuse.
    this.addSql(
      `alter table if exists "task_definition" drop constraint if exists "task_definition_kind_check";`,
    );
    this.addSql(
      `update "task_definition" set "active" = false, "deleted_at" = now() where "kind" = 'daily' and "deleted_at" is null;`,
    );
    this.addSql(
      `alter table if exists "task_definition" add constraint "task_definition_kind_check" check ("kind" in ('weekly', 'achievement')) not valid;`,
    );
  }
}
