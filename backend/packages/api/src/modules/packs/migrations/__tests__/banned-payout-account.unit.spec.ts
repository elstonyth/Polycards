import { Migration20261103230000 } from '../Migration20261103230000';

// payoutAccountBanned and the ban script read and write these exact columns, and
// the script's ON CONFLICT needs account_key to be the key.
test('creates the banned-number table the lookup and the ban script use', async () => {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261103230000.prototype,
  ) as Migration20261103230000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m.up();
  const up = sql.join('\n');
  expect(up).toContain('create table if not exists "banned_payout_account"');
  expect(up).toContain('"account_key" text not null primary key');
  expect(up).toContain('"bank_code" text null');
  expect(up).toContain('"reason" text null');
});
