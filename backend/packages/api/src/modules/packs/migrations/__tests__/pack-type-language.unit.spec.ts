import { Migration20261029120000 } from '../Migration20261029120000';

// pack.pack_type + pack.language: nullable admin tags (no backfill — unset
// packs show as "—" so the operator can see which still need one), with the
// closed sets and the "language only on an original pack" rule held at the DB.

async function emit(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261029120000.prototype,
  ) as Migration20261029120000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n').replace(/\s+/g, ' ');
}

test('up() adds both nullable columns with their closed sets and the original-only language rule', async () => {
  const sql = await emit('up');
  expect(sql.startsWith("set local lock_timeout = '5s';")).toBe(true);
  expect(sql).toContain(
    `add column if not exists "pack_type" text check ("pack_type" in ('classic', 'original', 'special')) null;`,
  );
  expect(sql).toContain(
    `add column if not exists "language" text check ("language" in ('en', 'jp')) null;`,
  );
  expect(sql).toContain(
    `add constraint "pack_language_original_check" check ("language" is null or ("pack_type" is not null and "pack_type" = 'original'));`,
  );
  expect(sql).not.toMatch(/\bupdate\b/i);
});

test('down() drops the rule and both columns', async () => {
  const sql = await emit('down');
  expect(sql).toContain(
    'drop constraint if exists "pack_language_original_check"',
  );
  expect(sql).toContain('drop column if exists "language"');
  expect(sql).toContain('drop column if exists "pack_type"');
});
