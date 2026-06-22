import { Migration20260623001000 } from '../Migration20260623001000';

test('hardening migration adds the self-referral CHECK and reversal-reference unique index', () => {
  const sql: string[] = [];
  const m = new Migration20260623001000();
  // @ts-expect-error — exercise the protected addSql collector
  m.addSql = (s: string) => sql.push(s);
  // @ts-expect-error — call the override directly (no DB)
  m.up();
  const joined = sql.join('\n');
  expect(joined).toMatch(/check \("customer_id" <> "sponsor_id"\)/);
  expect(joined).toMatch(/unique index .*"IDX_credit_transaction_reversal_reference".*reference like 'reversal:%'/s);
});
