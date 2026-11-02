import fs from 'fs';
import path from 'path';
import { Migration20261103120000 } from '../Migration20261103120000';

// visitor_signal: the table the snapshot (and so the model) declares, and the
// unique index recordVisitorSignal's ON CONFLICT depends on.

async function emit(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261103120000.prototype,
  ) as Migration20261103120000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n');
}

test('up() creates what the snapshot declares, and writes no rows', async () => {
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.snapshot-packs.json'), 'utf8'),
  ) as {
    tables: {
      name: string;
      columns: Record<string, { type: string; nullable: boolean }>;
      indexes: { keyName: string; unique: boolean }[];
    }[];
  };
  const table = snapshot.tables.find((t) => t.name === 'visitor_signal');
  expect(table?.columns.device_id).toMatchObject({
    type: 'text',
    nullable: false,
  });
  expect(table?.columns.last_seen_at).toMatchObject({
    type: 'timestamptz',
    nullable: false,
  });
  expect(
    table?.indexes.find(
      (i) => i.keyName === 'UQ_visitor_signal_customer_ip_device',
    )?.unique,
  ).toBe(true);

  const sql = await emit('up');
  expect(sql).toContain('create table if not exists "visitor_signal"');
  expect(sql).toContain(
    'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_visitor_signal_customer_ip_device" ON "visitor_signal" ("customer_id", "ip", "device_id")',
  );
  expect(sql).toContain(`"device_id" text not null default ''`);
  expect(sql).not.toMatch(/\bupdate\s|\binsert\s/i);
});

test('down() drops the table', async () => {
  expect(await emit('down')).toContain('drop table if exists "visitor_signal"');
});
