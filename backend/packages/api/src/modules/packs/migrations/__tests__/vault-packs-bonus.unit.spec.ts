import { Migration20261007120000 } from '../Migration20261007120000';
import { Migration20261008100000 } from '../Migration20261008100000';
import { BONUS_SOURCE_MIN_BP } from '../../bonus-credit';

// The CHECKs on credit_transaction.reason and pull.source only change with a
// migration. A value the model allows but the CHECK refuses fails every write
// that uses it — here, every bonus grant and every gift or bonus open. Pin the
// lists the migration emits to the values the code writes.

async function upSql(): Promise<string[]> {
  const sql: string[] = [];
  const m = Object.create(Migration20261007120000.prototype) as {
    addSql: (s: string) => void;
    up: () => Promise<void>;
  };
  m.addSql = (s) => sql.push(s);
  await m.up();
  return sql;
}

async function checkList(column: string): Promise<string[]> {
  for (const s of await upSql()) {
    const hit = s.match(/check\("(\w+)" in \(([^)]*)\)\)/);
    if (hit && hit[1] === column)
      return [...hit[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  throw new Error(`no CHECK on ${column}`);
}

describe('Migration20261007120000 (pack gifts + bonus credit)', () => {
  it('allows every credit reason the ledger writes, bonus_grant included', async () => {
    expect((await checkList('reason')).sort()).toEqual(
      [
        'buyback',
        'topup',
        'pack_open',
        'adjustment',
        'cashout',
        'voucher_claim',
        'reward_credit',
        'daily_reward',
        'referral_commission',
        'delivery_fee',
        'bonus_grant',
      ].sort(),
    );
  });

  it('allows the gift and bonus pull sources', async () => {
    expect((await checkList('source')).sort()).toEqual(
      ['pack', 'reward', 'free', 'gift', 'bonus'].sort(),
    );
  });

  it('adds the bonus columns and the pack_gift table additively', async () => {
    const sql = (await upSql()).join('\n');
    expect(sql).toMatch(/add column if not exists "bonus_cents" integer null/);
    expect(sql).toMatch(
      /add column if not exists "bonus_bp" integer not null default 0/,
    );
    expect(sql).toMatch(/create table if not exists "pack_gift"/);
    expect(sql).toMatch(/"raw_value_myr" jsonb not null/);
  });
});

describe('Migration20261008100000 (relabel old-rule bonus pulls)', () => {
  it('relabels exactly the rows the half rule calls pack', async () => {
    const sql: string[] = [];
    const m = Object.create(Migration20261008100000.prototype) as {
      addSql: (s: string) => void;
      up: () => Promise<void>;
    };
    m.addSql = (s) => sql.push(s);
    await m.up();
    expect(sql).toEqual([
      `update "pull" set "source" = 'pack' where "source" = 'bonus' and "bonus_bp" < ${BONUS_SOURCE_MIN_BP};`,
    ]);
  });
});
