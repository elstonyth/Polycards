import { Migration20261029091053 } from '../Migration20261029091053';

// Pins Migration20261029091053: indexes without the deleted_at scope. The
// daily cap (spentToday) and the review read deleted rows too, so the partial
// indexes can't serve them. Additive, so safe while old instances still serve.
async function emitted(dir: 'up' | 'down'): Promise<string[]> {
  const sql: string[] = [];
  const m = Object.create(Migration20261029091053.prototype) as InstanceType<
    typeof Migration20261029091053
  > & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql;
}

describe('Migration20261029091053 (assistant unscoped indexes)', () => {
  it('adds the two indexes with no WHERE', async () => {
    const up = await emitted('up');
    expect(up).toEqual([
      'CREATE INDEX IF NOT EXISTS "IDX_assistant_conversation_user_all" ON "assistant_conversation" ("user_id", "last_message_at");',
      'CREATE INDEX IF NOT EXISTS "IDX_assistant_message_conversation_role_all" ON "assistant_message" ("conversation_id", "role", "created_at");',
    ]);
    for (const line of up) expect(line).not.toMatch(/where/i);
  });

  it('drops only those two on down', async () => {
    expect(await emitted('down')).toEqual([
      'drop index if exists "IDX_assistant_conversation_user_all";',
      'drop index if exists "IDX_assistant_message_conversation_role_all";',
    ]);
  });
});
