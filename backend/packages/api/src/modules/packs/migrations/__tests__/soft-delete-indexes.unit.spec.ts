import fs from 'fs';
import path from 'path';
import { Migration20260729120000 } from '../Migration20260729120000';

/**
 * Guard for the six soft-delete indexes no migration ever created.
 *
 * NOT a tautology (the addSql-stub pattern of hardening-migration.unit.spec.ts
 * on its own would just re-assert the strings): every emitted statement is
 * cross-checked against .snapshot-packs.json, which is what the ORM believes
 * already exists. A typo'd index or table name would create a useless index
 * and leave the real one missing forever — db:generate can no longer emit it,
 * because the committed snapshot asserts it exists.
 */
const NAMES = [
  'IDX_ledger_entry_deleted_at',
  'IDX_ledger_sequence_deleted_at',
  'IDX_player_payout_details_deleted_at',
  'IDX_purchase_invoice_deleted_at',
  'IDX_purchase_invoice_line_deleted_at',
  'IDX_stock_movement_deleted_at',
];

async function emit(dir: 'up' | 'down'): Promise<string[]> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20260729120000.prototype,
  ) as Migration20260729120000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql;
}

test('up() emits exactly the six index definitions the ORM snapshot declares', async () => {
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.snapshot-packs.json'), 'utf8'),
  ) as { tables: { indexes?: { keyName: string; expression?: string }[] }[] };
  const byName = new Map<string, string>();
  for (const t of snapshot.tables ?? []) {
    for (const i of t.indexes ?? []) {
      if (i.expression) byName.set(i.keyName, i.expression);
    }
  }

  const sql = await emit('up');
  expect(sql).toHaveLength(NAMES.length);
  for (const name of NAMES) {
    const declared = byName.get(name);
    // The snapshot must actually declare it — otherwise this migration is
    // creating an index nothing expects.
    expect(declared).toBeDefined();
    // Emitted statement == snapshot expression (plus the statement terminator).
    expect(sql).toContain(declared + ';');
  }
});

test('down() drops every index up() created', async () => {
  const sql = await emit('down');
  expect(sql).toEqual(
    NAMES.map((n) => `drop index if exists "${n}";`),
  );
});
