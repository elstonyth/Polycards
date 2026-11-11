import { updateCreditTransactionsById } from '../batch-update';

function fakeEm() {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    em: {
      execute: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return [] as never;
      },
    },
  };
}

describe('updateCreditTransactionsById', () => {
  it('writes every row in one statement, values bound in order', async () => {
    const { em, calls } = fakeEm();
    await updateCreditTransactionsById(em, 'external_funded_cents = v.val', [
      ['ct_a', 5000],
      ['ct_b', -2000],
      ['ct_c', 0],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe(
      'UPDATE credit_transaction AS t SET external_funded_cents = v.val, updated_at = now() ' +
        'FROM (VALUES (?, ?::bigint), (?, ?::bigint), (?, ?::bigint)) AS v(id, val) WHERE t.id = v.id',
    );
    expect(calls[0].params).toEqual(['ct_a', 5000, 'ct_b', -2000, 'ct_c', 0]);
  });

  it('splits a long list into chunks and keeps every row', async () => {
    const { em, calls } = fakeEm();
    const rows = Array.from(
      { length: 5 },
      (_, i) => [`ct_${i}`, i * 100] as const,
    );
    await updateCreditTransactionsById(
      em,
      'external_funded_cents = t.external_funded_cents - v.val',
      rows,
      2,
    );
    expect(calls.map((c) => c.params.length)).toEqual([4, 4, 2]);
    expect(calls.flatMap((c) => c.params)).toEqual(rows.flat());
    for (const c of calls) {
      expect(c.sql).toContain(
        'SET external_funded_cents = t.external_funded_cents - v.val,',
      );
    }
  });

  it('issues no statement for no rows', async () => {
    const { em, calls } = fakeEm();
    await updateCreditTransactionsById(em, 'external_funded_cents = v.val', []);
    expect(calls).toHaveLength(0);
  });

  it('never puts an id into the SQL text', async () => {
    const { em, calls } = fakeEm();
    const evil = "x'); DROP TABLE credit_transaction; --";
    await updateCreditTransactionsById(em, 'external_funded_cents = v.val', [
      [evil, 1],
    ]);
    expect(calls[0].sql).not.toContain(evil);
    expect(calls[0].params).toEqual([evil, 1]);
  });
});
