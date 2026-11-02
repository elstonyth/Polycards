import fs from 'fs';
import path from 'path';
import { Migration20261102100000 } from '../Migration20261102100000';

/** Same guard as pull-pack-index.unit.spec.ts: the migration must create the
 *  index exactly as the ORM snapshot (and so the TicketSpin model) declares it. */
async function emit(dir: 'up' | 'down'): Promise<string[]> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261102100000.prototype,
  ) as Migration20261102100000 & { addSql: (s: string) => void };
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
    .find((i) => i.keyName === 'IDX_ticket_spin_pack_id_rolled_at');

  expect(await emit('up')).toEqual([`${declared?.expression};`]);
  expect(await emit('down')).toEqual([
    'DROP INDEX IF EXISTS "IDX_ticket_spin_pack_id_rolled_at";',
  ]);
});
