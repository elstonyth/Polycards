import { Migration20261029040244 } from '../Migration20261029040244';

// Pins the SQL Migration20261029040244 emits: the assistant's settings
// singleton and its chat history (spec 2026-10-29-admin-ai-assistant-design).
async function emitted(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(Migration20261029040244.prototype) as InstanceType<
    typeof Migration20261029040244
  > & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n');
}

describe('Migration20261029040244 (assistant tables)', () => {
  it('creates the three tables, the role check and the lookup indexes', async () => {
    const up = await emitted('up');
    for (const table of [
      'assistant_settings',
      'assistant_conversation',
      'assistant_message',
    ]) {
      expect(up).toMatch(
        new RegExp(`create table if not exists "${table}" \\(`),
      );
    }
    expect(up).toMatch(/"openrouter_key_sealed" text null/);
    expect(up).toMatch(
      /"role" text check \("role" in \('user', 'assistant'\)\) not null/,
    );
    expect(up).toMatch(/"cost_usd" real not null default 0/);
    expect(up).toMatch(
      /CREATE INDEX IF NOT EXISTS "IDX_assistant_conversation_user_id" ON "assistant_conversation" \("user_id", "last_message_at"\) WHERE deleted_at IS NULL;/,
    );
    expect(up).toMatch(
      /CREATE INDEX IF NOT EXISTS "IDX_assistant_message_conversation_id" ON "assistant_message" \("conversation_id", "created_at"\) WHERE deleted_at IS NULL;/,
    );
  });

  it('drops only its own tables on down', async () => {
    const down = await emitted('down');
    expect(down.match(/drop table if exists/g)).toHaveLength(3);
    expect(down).not.toMatch(/drop table if exists "(?!assistant_)/);
  });
});
