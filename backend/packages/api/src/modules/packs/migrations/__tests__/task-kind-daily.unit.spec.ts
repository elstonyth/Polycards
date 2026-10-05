import { Migration20261006100000 } from '../Migration20261006100000';
import { TASK_KINDS } from '../../tasks';

// The kind CHECK is the DB's half of the cadence list in tasks.ts — a kind
// the code accepts but the CHECK refuses fails every admin save of it.

async function emit(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261006100000.prototype,
  ) as Migration20261006100000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n').replace(/\s+/g, ' ');
}

test('up() swaps the kind CHECK to exactly the kinds tasks.ts knows', async () => {
  const sql = await emit('up');
  expect(sql.startsWith("set local lock_timeout = '5s';")).toBe(true);
  expect(sql).toContain(
    'drop constraint if exists "task_definition_kind_check"',
  );
  const list = TASK_KINDS.map((k) => `'${k}'`).join(', ');
  expect(sql).toContain(
    `add constraint "task_definition_kind_check" check ("kind" in (${list}));`,
  );
});

test('down() narrows back without failing on daily rows (NOT VALID)', async () => {
  expect(await emit('down')).toContain(
    `check ("kind" in ('weekly', 'achievement')) not valid;`,
  );
});

test("up() adds the nullable retired_at that bounds a retired task's claims", async () => {
  expect(await emit('up')).toContain(
    'add column if not exists "retired_at" timestamptz null;',
  );
  expect(await emit('down')).toContain('drop column if exists "retired_at"');
});
