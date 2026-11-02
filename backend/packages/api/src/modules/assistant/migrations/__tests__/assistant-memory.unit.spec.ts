import { Migration20261029060244 } from '../Migration20261029060244';

// Pins Migration20261029060244: the assistant's saved notes, personal
// (scope user) or everyone's (scope shared).
async function emitted(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(Migration20261029060244.prototype) as InstanceType<
    typeof Migration20261029060244
  > & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n');
}

describe('Migration20261029060244 (assistant memory)', () => {
  it('creates the notes table with its scope check and lookup index', async () => {
    const up = await emitted('up');
    expect(up).toContain('create table if not exists "assistant_memory" (');
    expect(up).toContain(
      `"scope" text check ("scope" in ('user', 'shared')) not null`,
    );
    expect(up).toContain('"user_id" text not null');
    expect(up).toContain('"content" text not null');
    expect(up).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_assistant_memory_scope_user" ON "assistant_memory" ("scope", "user_id") WHERE deleted_at IS NULL;',
    );
  });

  it('drops only its own table on down', async () => {
    expect(await emitted('down')).toBe(
      'drop table if exists "assistant_memory" cascade;',
    );
  });
});
