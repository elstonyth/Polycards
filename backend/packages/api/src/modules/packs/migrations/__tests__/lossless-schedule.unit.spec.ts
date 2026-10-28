import fs from 'fs';
import path from 'path';
import { Migration20261017120000 } from '../Migration20261017120000';

/**
 * lossless_schedule migration, cross-checked against .snapshot-packs.json.
 *
 * The module integration spec builds its schema from the MODEL, never from
 * this migration, so it cannot catch a hand-written DDL that drifted from what
 * the ORM believes exists. This does: every column and index the snapshot
 * declares for the table must be emitted, verbatim for the indexes, and the
 * down() must undo exactly the table.
 */
type Snapshot = {
  tables: {
    name: string;
    columns: Record<string, unknown>;
    indexes: { keyName: string; expression?: string }[];
  }[];
};

async function emit(dir: 'up' | 'down'): Promise<string[]> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261017120000.prototype,
  ) as Migration20261017120000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql;
}

const table = (): Snapshot['tables'][number] => {
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.snapshot-packs.json'), 'utf8'),
  ) as Snapshot;
  const t = snapshot.tables.find((x) => x.name === 'lossless_schedule');
  if (!t) throw new Error('lossless_schedule missing from the snapshot');
  return t;
};

test('up() locks with a timeout first, then creates every snapshot column', async () => {
  const sql = await emit('up');
  expect(sql[0]).toBe("set local lock_timeout = '5s';");
  const create = sql.find((s) => s.startsWith('create table'))!;
  for (const col of Object.keys(table().columns)) {
    expect(create).toContain(`"${col}"`);
  }
  expect(create).toContain('constraint "lossless_schedule_pkey"');
});

test('up() emits exactly the index definitions the snapshot declares', async () => {
  const sql = await emit('up');
  const declared = table()
    .indexes.filter((i) => i.expression)
    .map((i) => i.expression + ';');
  expect(declared).toHaveLength(2);
  for (const expr of declared) expect(sql).toContain(expr);
});

test('down() drops the table and nothing else', async () => {
  expect(await emit('down')).toEqual([
    'drop table if exists "lossless_schedule" cascade;',
  ]);
});
