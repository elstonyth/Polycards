import { Migration20261029054815 } from '../Migration20261029054815';

// Pins Migration20261029054815: the two nullable settings columns for the
// house look of AI images (image_style) and the uploaded reference posts
// (style_refs). Additive: old code never reads them.
async function emitted(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(Migration20261029054815.prototype) as InstanceType<
    typeof Migration20261029054815
  > & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n');
}

describe('Migration20261029054815 (assistant image style)', () => {
  it('adds the two nullable columns', async () => {
    expect(await emitted('up')).toBe(
      'alter table if exists "assistant_settings" add column if not exists "image_style" text null, add column if not exists "style_refs" jsonb null;',
    );
  });

  it('drops only those columns on down', async () => {
    expect(await emitted('down')).toBe(
      'alter table if exists "assistant_settings" drop column if exists "image_style", drop column if exists "style_refs";',
    );
  });
});
