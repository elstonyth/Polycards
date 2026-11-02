import { Migration20261031100200 } from '../Migration20261031100200';

// This migration rewrites the ticket reason CHECK after Lucky Draw's
// Migration20261030100000 added pack_spin. Dropping it there blocks the deploy on
// existing rows, or fails every Lucky Pack spin.
const reasonCheck = async (run: 'up' | 'down') => {
  const migration = Object.create(Migration20261031100200.prototype) as InstanceType<
    typeof Migration20261031100200
  > & { addSql: (sql: string) => void };
  const statements: string[] = [];
  migration.addSql = (sql) => statements.push(sql);
  await migration[run]();
  return statements.find((sql) =>
    /add constraint "lucky_draw_ticket_reason_check"/.test(sql),
  )!;
};

describe('Migration20261031100200 ticket reasons', () => {
  it('keeps every existing reason and adds coin_flip', async () => {
    const check = await reasonCheck('up');
    for (const reason of ['task_claim', 'entry', 'refund', 'admin_grant', 'pack_spin', 'coin_flip']) {
      expect(check).toContain(`'${reason}'`);
    }
  });

  it('still keeps pack_spin when it rolls back', async () => {
    const check = await reasonCheck('down');
    expect(check).toContain("'pack_spin'");
    expect(check).not.toContain("'coin_flip'");
  });
});
