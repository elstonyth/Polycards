import { Migration20261029081358 } from '../Migration20261029081358';

// Pins Migration20261029081358: voice. Additive, so safe while old instances
// still serve: a wider role check (voice rows carry what reading aloud
// cost) and three settings columns with defaults.
async function emitted(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(Migration20261029081358.prototype) as InstanceType<
    typeof Migration20261029081358
  > & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n');
}

describe('Migration20261029081358 (assistant voice)', () => {
  it('lets a message be a voice row and adds the voice settings with defaults', async () => {
    const up = await emitted('up');
    expect(up).toContain(
      `add constraint "assistant_message_role_check" check("role" in ('user', 'assistant', 'voice'));`,
    );
    expect(up).toContain(
      `add column if not exists "stt_model" text not null default 'google/gemini-3.5-flash-lite'`,
    );
    expect(up).toContain(
      `add column if not exists "voice_model" text not null default 'google/gemini-3.8-flash-lite-tts'`,
    );
    expect(up).toContain(
      `add column if not exists "voice" text not null default 'Kore'`,
    );
  });

  it('drops the voice rows, narrows the role check and drops the columns on down', async () => {
    const down = await emitted('down');
    const del = down.indexOf(
      `delete from "assistant_message" where "role" = 'voice';`,
    );
    const narrow = down.indexOf(`check("role" in ('user', 'assistant'))`);
    // Rows first, or the narrower check fails on them.
    expect(del).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(del);
    expect(down).toContain('drop column if exists "stt_model"');
  });
});
