import fs from 'fs';
import path from 'path';
import { Migration20260930120000 } from '../Migration20260930120000';

/**
 * The per-pack pull index must be created exactly as the ORM snapshot (and so
 * the Pull model) declares it. A drifted name or column list would build a
 * useless index while db:generate, trusting the snapshot, never emits the
 * real one — same guard as soft-delete-indexes.unit.spec.ts.
 */
async function emit(dir: 'up' | 'down'): Promise<string[]> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20260930120000.prototype,
  ) as Migration20260930120000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql;
}

test('up() creates the index the snapshot declares; down() drops it', async () => {
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.snapshot-packs.json'), 'utf8'),
  ) as { tables: { indexes?: { keyName: string; expression?: string }[] }[] };
  const declared = snapshot.tables
    .flatMap((t) => t.indexes ?? [])
    .find((i) => i.keyName === 'IDX_pull_pack_id_rolled_at');

  expect(await emit('up')).toEqual([`${declared?.expression};`]);
  expect(await emit('down')).toEqual([
    'DROP INDEX IF EXISTS "IDX_pull_pack_id_rolled_at";',
  ]);
});
