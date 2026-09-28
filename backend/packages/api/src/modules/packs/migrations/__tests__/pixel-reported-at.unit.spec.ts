import { Migration20260928120000 } from '../Migration20260928120000';

// gateway_deposit.pixel_reported_at: the backfill is what stops the Meta Pixel
// from replaying every deposit settled before tracking shipped, and it runs
// against a money table — so it must touch settled rows only, only once, and
// never rewrite updated_at.

async function emit(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20260928120000.prototype,
  ) as Migration20260928120000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n').replace(/\s+/g, ' ');
}

test('up() adds the nullable column, then marks only already-settled rows reported', async () => {
  const sql = await emit('up');
  // Fail the deploy fast rather than queue payments behind the ALTER's lock.
  expect(sql.startsWith("set local lock_timeout = '5s';")).toBe(true);
  expect(sql).toContain(
    'alter table if exists "gateway_deposit" add column if not exists "pixel_reported_at" timestamptz null;',
  );
  expect(sql).toContain(
    'update "gateway_deposit" set "pixel_reported_at" = now() where "status" = \'settled\' and "pixel_reported_at" is null;',
  );
  expect(sql).not.toMatch(/updated_at/);
});

test('down() drops the column', async () => {
  expect(await emit('down')).toContain(
    'drop column if exists "pixel_reported_at"',
  );
});
