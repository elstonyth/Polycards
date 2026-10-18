import { Migration20261015160000 } from '../Migration20261015160000';

// Settlement's Acknowledge: three nullable columns on each gateway table,
// added without writing a row (the CHECK lists are pinned by
// admin-audit-config-enums.unit.spec.ts).

async function emit(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261015160000.prototype,
  ) as Migration20261015160000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n');
}

test('up() adds the acknowledgement columns to both gateway tables and writes no rows', async () => {
  const sql = await emit('up');
  expect(sql.startsWith("set local lock_timeout = '5s';")).toBe(true);
  for (const table of ['gateway_deposit', 'gateway_withdrawal']) {
    for (const col of [
      '"audit_ack_note" text null',
      '"audit_ack_by" text null',
      '"audit_ack_at" timestamptz null',
    ]) {
      expect(sql).toContain(
        `alter table if exists "${table}" add column if not exists ${col};`,
      );
    }
  }
  expect(sql).not.toMatch(/\bupdate\b|\binsert\b/i);
});

test('down() refuses while acknowledgement audit rows exist, then drops the columns', async () => {
  const sql = await emit('down');
  expect(sql).toContain("action = 'acknowledge_finding'");
  expect(sql).toContain('drop column if exists "audit_ack_at"');
  expect(sql.indexOf('RAISE EXCEPTION')).toBeLessThan(
    sql.indexOf('drop column'),
  );
});
