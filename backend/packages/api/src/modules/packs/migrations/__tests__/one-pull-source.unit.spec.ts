import { Migration20261102180000 } from '../Migration20261102180000';

describe('Migration20261102180000 (one pull counted toward its task)', () => {
  it('touches one customer, one card, one window, sold rows only', async () => {
    const sql: string[] = [];
    const m = Object.create(Migration20261102180000.prototype) as {
      addSql: (s: string) => void;
      up: () => Promise<void>;
    };
    m.addSql = (s) => sql.push(s);
    await m.up();
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^update "pull" set "source" = 'pack' where /);
    expect(sql[0]).toMatch(/md5\("customer_id"\) = '[0-9a-f]{32}'/);
    expect(sql[0]).toMatch(/"card_id" = 'magikarp-80-psa-10-4947437'/);
    expect(sql[0]).toMatch(/"status" = 'bought_back'/);
    expect(sql[0]).toMatch(/"created_at" >= '2026-11-02T07:00:00Z'/);
    expect(sql[0]).toMatch(/"created_at" < '2026-11-02T10:30:00Z'/);
    expect(sql[0]).toMatch(/"deleted_at" is null/);
  });
});
