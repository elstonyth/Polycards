import { creditLockKey, lockCredit } from '../credit-posting';

const LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))';

describe('lockCredit', () => {
  it('keeps the key byte-identical (rolling deploy)', () => {
    expect(creditLockKey('cus_1')).toBe('credit:cus_1');
  });

  it('takes one lock per distinct id, sorted, with the same SQL as before', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    await lockCredit({ transactionManager: { execute } } as never, 'cus_b', 'cus_a', 'cus_b');
    expect(execute.mock.calls).toEqual([
      [LOCK_SQL, ['credit:cus_a']],
      [LOCK_SQL, ['credit:cus_b']],
    ]);
  });

  it('refuses to run outside a transaction', async () => {
    const execute = jest.fn();
    await expect(lockCredit({ manager: { execute } } as never, 'cus_a')).rejects.toThrow(/transaction/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes a lock error through unchanged (callers translate 55P03)', async () => {
    const error = Object.assign(new Error('lock timeout'), { code: '55P03' });
    const execute = jest.fn().mockRejectedValue(error);
    await expect(lockCredit({ transactionManager: { execute } } as never, 'cus_a')).rejects.toBe(error);
  });
});
