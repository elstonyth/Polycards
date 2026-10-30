import { Migration20261029060836 } from '../Migration20261029060836';

// Pins Migration20261029060836: the assistant's scheduled tasks, and the
// partial index the due-task job reads them through.
async function emitted(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(Migration20261029060836.prototype) as InstanceType<
    typeof Migration20261029060836
  > & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n');
}

describe('Migration20261029060836 (assistant schedule)', () => {
  it('creates the task table and the due-task index', async () => {
    const up = await emitted('up');
    expect(up).toContain('create table if not exists "assistant_schedule" (');
    for (const column of [
      `"every" text check ("every" in ('day', 'week')) not null`,
      '"at_time" text not null',
      '"weekday" integer null',
      '"enabled" boolean not null default true',
      '"next_run_at" timestamptz not null',
      '"conversation_id" text null',
    ]) {
      expect(up).toContain(column);
    }
    expect(up).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_assistant_schedule_due" ON "assistant_schedule" ("enabled", "next_run_at") WHERE deleted_at IS NULL;',
    );
  });

  it('drops only its own table on down', async () => {
    expect(await emitted('down')).toBe(
      'drop table if exists "assistant_schedule" cascade;',
    );
  });
});
