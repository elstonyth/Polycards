import { Migration20260805000000 } from '../Migration20260805000000';

/**
 * Migration guard for zeroing the ladder's voucher payouts — unit (SQL-string
 * inspection), same pattern as hardening-migration.unit.spec.ts.
 *
 * The one failure mode worth pinning: voucher_amount is a `model.bigNumber()`,
 * which is TWO columns. An UPDATE that sets only the numeric column leaves
 * raw_voucher_amount holding the old figure, the ORM reads the raw sidecar
 * back, and the ladder keeps paying — a migration that runs clean and changes
 * nothing.
 */
test('Migration20260805000000 zeroes voucher_amount AND its raw_ sidecar', async () => {
  const sql: string[] = [];
  const m = Object.create(
    Migration20260805000000.prototype,
  ) as Migration20260805000000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m.up();
  const joined = sql.join('\n');

  expect(joined).toMatch(/UPDATE "vip_level"/);
  expect(joined).toMatch(/"voucher_amount" = 0/);
  expect(joined).toMatch(
    /"raw_voucher_amount" = jsonb_build_object\('value', '0', 'precision', 20\)/,
  );
  // Soft-deleted rows are not live config and stay untouched, and the WHERE
  // makes a re-run a no-op rather than a full-table rewrite.
  expect(joined).toMatch(/"deleted_at" IS NULL/);
  // The two halves must be OR'd. AND is the shape that skips a row whose
  // numeric column is already 0 while the sidecar still holds 12,000 — exactly
  // the half-written state this migration exists to repair.
  expect(joined).toMatch(
    /"voucher_amount" <> 0\s*OR\s*"raw_voucher_amount"->>'value' IS DISTINCT FROM '0'/,
  );
});

test('down() is a no-op — the cleared amounts are not recoverable', async () => {
  const sql: string[] = [];
  const m = Object.create(
    Migration20260805000000.prototype,
  ) as Migration20260805000000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m.down();
  expect(sql).toEqual([]);
});
