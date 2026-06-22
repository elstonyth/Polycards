import { Migration20260623001000 } from '../Migration20260623001000';

test('hardening migration adds the self-referral CHECK and reversal-reference unique index', async () => {
  const sql: string[] = [];
  // Construct without the MikroORM driver/config the real constructor needs, and
  // stub the protected addSql collector — we only assert the emitted SQL.
  const m = Object.create(
    Migration20260623001000.prototype,
  ) as Migration20260623001000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m.up();
  const joined = sql.join('\n');
  expect(joined).toMatch(/check \("customer_id" <> "sponsor_id"\)/);
  expect(joined).toMatch(/unique index .*"IDX_credit_transaction_reversal_reference".*reference like 'reversal:%'/s);
});
