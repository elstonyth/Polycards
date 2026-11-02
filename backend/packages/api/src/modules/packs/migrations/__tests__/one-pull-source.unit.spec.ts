import { Migration20261102180000 } from '../Migration20261102180000';

describe('Migration20261102180000 (one pull counted toward its task)', () => {
  const upSql = async () => {
    const sql: string[] = [];
    const m = Object.create(Migration20261102180000.prototype) as {
      addSql: (s: string) => void;
      up: () => Promise<void>;
    };
    m.addSql = (s) => sql.push(s);
    await m.up();
    return sql;
  };

  it('touches one customer, one card, one window, sold rows only', async () => {
    const sql = await upSql();
    expect(sql).toHaveLength(2);
    for (const s of sql) {
      expect(s).toMatch(/^update "pull" set "source" = 'pack'/);
      expect(s).toMatch(/md5\("customer_id"\) = '[0-9a-f]{32}'/);
      expect(s).toMatch(/"card_id" = 'magikarp-80-psa-10-4947437'/);
      expect(s).toMatch(/"status" = 'bought_back'/);
      expect(s).toMatch(/"created_at" >= '2026-11-02T07:00:00Z'/);
      expect(s).toMatch(/"created_at" < '2026-11-02T10:30:00Z'/);
      expect(s).toMatch(/"deleted_at" is null/);
    }
  });

  it('adds no board value: only a row that was off the boards is zeroed', async () => {
    const [bonus, free] = await upSql();
    expect(bonus).toMatch(/where "source" = 'bonus'/);
    expect(bonus).not.toMatch(/recorded_value_usd/);
    expect(free).toMatch(/where "source" in \('reward', 'gift'\)/);
    expect(free).toMatch(/"recorded_value_usd" = 0/);
    expect(free).toMatch(/"raw_recorded_value_usd" = '\{"value":"0"/);
  });
});
