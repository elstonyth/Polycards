import { Migration20261107150000 } from '../Migration20261107150000';
import { DELIVERY_STATUSES } from '../../delivery';

// The status CHECK is the DB's half of DELIVERY_STATUSES: a status the code
// accepts but the CHECK refuses fails every move to it.

async function emit(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261107150000.prototype,
  ) as Migration20261107150000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n').replace(/\s+/g, ' ');
}

const checkList = (sql: string): string[] =>
  /check \("status" in \(([^)]*)\)\)/
    .exec(sql)![1]
    .split(', ')
    .map((v) => v.replace(/'/g, ''));

test('up() keeps the legacy union and adds every status the code knows', async () => {
  const sql = await emit('up');
  expect(sql.startsWith("set local lock_timeout = '5s';")).toBe(true);
  expect(sql).toContain(
    'drop constraint if exists "delivery_order_status_check"',
  );
  const allowed = checkList(sql);
  for (const s of DELIVERY_STATUSES) expect(allowed).toContain(s);
  expect(allowed).toEqual(expect.arrayContaining(['packing', 'delivered']));
});

test('down() moves packed orders back to ready_to_ship, THEN narrows', async () => {
  const sql = await emit('down');
  const move = sql.indexOf(
    `update "delivery_order" set "status" = 'ready_to_ship' where "status" = 'pending_ship';`,
  );
  const narrow = sql.indexOf('add constraint "delivery_order_status_check"');
  expect(move).toBeGreaterThan(-1);
  expect(narrow).toBeGreaterThan(move);
  expect(checkList(sql)).not.toContain('pending_ship');
});
