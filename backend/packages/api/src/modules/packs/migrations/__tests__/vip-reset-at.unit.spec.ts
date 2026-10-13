import fs from 'fs';
import path from 'path';
import { Migration20261008120000 } from '../Migration20261008120000';

// vip_member_state.vip_reset_at: the column the snapshot (and so the model)
// declares, added without touching any row — no customer is reset here.

async function emit(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261008120000.prototype,
  ) as Migration20261008120000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n');
}

test('up() adds the nullable timestamptz the snapshot declares, and writes no rows', async () => {
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.snapshot-packs.json'), 'utf8'),
  ) as {
    tables: {
      name: string;
      columns: Record<string, { type: string; nullable: boolean }>;
    }[];
  };
  const col = snapshot.tables.find((t) => t.name === 'vip_member_state')
    ?.columns.vip_reset_at;
  expect(col).toMatchObject({ type: 'timestamptz', nullable: true });

  const sql = await emit('up');
  expect(sql.startsWith("set local lock_timeout = '5s';")).toBe(true);
  expect(sql).toContain(
    'alter table if exists "vip_member_state" add column if not exists "vip_reset_at" timestamptz null;',
  );
  expect(sql).not.toMatch(/update|insert/i);
});

test('down() drops the column', async () => {
  expect(await emit('down')).toContain('drop column if exists "vip_reset_at"');
});
