import { Migration20261013090000 } from '../Migration20261013090000';

/**
 * The fee-percent migration (payment-fx.ts) — unit, SQL-string inspection,
 * same pattern as vip-voucher-zero.unit.spec.ts. Run for real against
 * Postgres on 2026-10-13: the live SGD row (mid 3.188752, markup 0.10)
 * backfills to 3.1360% each way, top-up 3.088753 vs 3.088752 before.
 */
async function upSql(): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261013090000.prototype,
  ) as Migration20261013090000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m.up();
  return sql.join('\n');
}

test('backfills both percentages AND their raw_ sidecars from the old markup', async () => {
  const sql = await upSql();
  for (const field of ['deposit_fee_percent', 'payout_fee_percent']) {
    expect(sql).toMatch(new RegExp(`${field} = m\\.pct`));
    expect(sql).toMatch(
      new RegExp(
        `raw_${field} = jsonb_build_object\\('value', m\\.pct::text, 'precision', 20\\)`,
      ),
    );
  }
});

test('only a row that had a markup is switched on, measured against its effective mid', async () => {
  const sql = await upSql();
  expect(sql).toMatch(/fee_enabled = true/);
  expect(sql).toMatch(/where markup > 0 and fee_enabled is null/);
  // A pinned manual rate is the mid the old markup was priced against.
  expect(sql).toMatch(
    /case when manual_override and manual_rate > 0 then manual_rate else rate end/,
  );
  // A row with no usable mid is left unconfigured, never divided by zero.
  expect(sql).toMatch(/else rate end\) > 0/);
});

test('leaves the old markup column alone, so a rollback still prices', async () => {
  const sql = await upSql();
  expect(sql).not.toMatch(/drop column if exists "markup"/);
  expect(sql).not.toMatch(/set markup/i);
});
