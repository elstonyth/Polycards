import { Migration20261124120000 } from '../Migration20261124120000';

// forceLuckyDrawWinner (lucky-draw-operations.ts) writes this exact column,
// and the raw UPDATE keeps updated_at untouched — the name must not drift.
test('adds the forced_winner_id column lucky-draw-event writes', async () => {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261124120000.prototype,
  ) as Migration20261124120000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m.up();
  const up = sql.join('\n');
  expect(up).toContain(
    'alter table if exists "lucky_draw_event" add column if not exists "forced_winner_id" text null',
  );
  await m.down();
  expect(sql.join('\n')).toContain(
    'alter table if exists "lucky_draw_event" drop column if exists "forced_winner_id"',
  );
});
