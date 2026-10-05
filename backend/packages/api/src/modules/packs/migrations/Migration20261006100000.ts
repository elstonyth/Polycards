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
  }

  override async down(): Promise<void> {
    // NOT VALID: a rollback must not fail on daily rows already written —
    // they stay (retire them in the admin), new ones are refused.
    this.addSql(
      `alter table if exists "task_definition" drop constraint if exists "task_definition_kind_check";`,
    );
    this.addSql(
      `alter table if exists "task_definition" add constraint "task_definition_kind_check" check ("kind" in ('weekly', 'achievement')) not valid;`,
    );
  }
}
