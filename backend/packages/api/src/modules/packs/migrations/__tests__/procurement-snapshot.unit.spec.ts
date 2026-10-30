import { Migration20261028180000 } from '../Migration20261028180000';

// Pins the SQL Migration20261028180000 emits: the procurement_snapshot table
// the 12am stock run writes its to-buy list into.
async function emitted(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(Migration20261028180000.prototype) as InstanceType<
    typeof Migration20261028180000
  > & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n');
}

describe('Migration20261028180000 (procurement snapshot)', () => {
  it('creates the snapshot table with the soft-delete and taken_at indexes', async () => {
    const up = await emitted('up');
    expect(up).toMatch(/create table if not exists "procurement_snapshot" \(/);
    expect(up).toMatch(/"taken_at" timestamptz not null/);
    expect(up).toMatch(/"to_buy" jsonb not null/);
    expect(up).toMatch(
      /CREATE INDEX IF NOT EXISTS "IDX_procurement_snapshot_deleted_at" ON "procurement_snapshot" \("deleted_at"\) WHERE deleted_at IS NULL;/,
    );
    expect(up).toMatch(
      /CREATE INDEX IF NOT EXISTS "IDX_procurement_snapshot_taken_at" ON "procurement_snapshot" \("taken_at"\) WHERE deleted_at IS NULL;/,
    );
  });

  it('drops only its own table on down', async () => {
    expect(await emitted('down')).toBe(
      'drop table if exists "procurement_snapshot" cascade;',
    );
  });
});
