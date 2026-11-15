import { BONUS_NOT_SPENDABLE_MESSAGE } from '../bonus-credit';
import { creditLockKey, lockCredit, planPosting } from '../credit-posting';

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

describe('planPosting', () => {
  const totals = (balance: number, bonus = 0, external = 0) => ({ balanceCents: balance, bonusCents: bonus, externalCents: external });
  const plan = (input: Partial<Parameters<typeof planPosting>[0]>, t = totals(0)) =>
    planPosting({ customerId: 'cus_1', amount: 0, reason: 'adjustment', ...input } as Parameters<typeof planPosting>[0], t);

  it('a top-up is all external money in, rounded to the sen, and may unfreeze', () => {
    expect(plan({ reason: 'topup', amount: 10.004, reference: 'gw', idempotencyReference: 'anchor' }, totals(500))).toEqual({
      row: { customer_id: 'cus_1', amount: 10, reason: 'topup', pull_id: null, reference: 'gw',
        external_funded_cents: 1000, bonus_cents: 0, source_transaction_id: 'anchor' },
      unfreeze: true, balanceAfterCents: 1500, bonusAfterCents: 0,
    });
  });

  it.each([
    [{ reason: 'topup', amount: 0 }, 'topup amount must be greater than 0.'],
    [{ reason: 'pack_open', amount: 1 }, 'pack_open amount must be less than 0.'],
    [{ reason: 'bonus_grant', amount: 5, bonusCents: 400 }, 'A bonus_grant row must carry bonusCents equal to its amount.'],
    [{ reason: 'adjustment', amount: 5, bonusCents: 500 }, 'Only a bonus_grant or delivery_fee row may carry bonusCents.'],
    [{ reason: 'delivery_fee', amount: -5, bonusCents: 100 }, 'A delivery fee charge takes its bonus share itself.'],
    [{ reason: 'delivery_fee', amount: 5, bonusCents: 600 }, 'A delivery fee refund can return at most its own amount as bonus.'],
  ] as const)('refuses misuse %#', (input, message) => {
    expect(() => plan(input as never, totals(10_000))).toThrow(message);
  });

  it('pack_open (this path) consumes external money up to the price, no bonus', () => {
    expect(plan({ reason: 'pack_open', amount: -12.5, sourceTransactionId: 'open_1' }, totals(1500, 0, 1000))).toMatchObject({
      row: { amount: -12.5, external_funded_cents: -1000, bonus_cents: 0, source_transaction_id: 'open_1' },
      unfreeze: false, balanceAfterCents: 250,
    });
  });

  it('a delivery fee charge takes bonus first; its refund returns the bonus it took', () => {
    expect(plan({ reason: 'delivery_fee', amount: -15 }, totals(5300, 300)).row).toMatchObject({ bonus_cents: -300 });
    expect(plan({ reason: 'delivery_fee', amount: 15, bonusCents: 300 }, totals(3800)).row).toMatchObject({ bonus_cents: 300 });
  });

  it('task, prize and voucher credit is whole-row bonus; a bonus take-back cannot go below 0', () => {
    expect(plan({ reason: 'reward_credit', amount: 2.5 }).row).toMatchObject({ bonus_cents: 250, external_funded_cents: 0 });
    expect(plan({ reason: 'voucher_claim', amount: 5 }).row).toMatchObject({ bonus_cents: 500 });
    expect(() => plan({ reason: 'bonus_grant', amount: -9, bonusCents: -900 }, totals(2000, 500)))
      .toThrow('Bonus credit cannot go below RM 0 (bonus balance RM 5.00).');
  });

  it('other debits are floored on the normal balance; a negative bonus Σ is clamped to 0', () => {
    expect(() => plan({ amount: -26, floor: 0 }, totals(3000, 500))).toThrow(BONUS_NOT_SPENDABLE_MESSAGE);
    expect(() => plan({ amount: -20, floor: 0 }, totals(1500)))
      .toThrow("Deduction exceeds the customer's balance (RM 15.00) — the balance cannot go below RM 0.00.");
    expect(() => plan({ reason: 'pack_open', amount: -25 }, totals(300)))
      .toThrow('Not enough credits to open this pack. It costs RM 25.00 and you have RM 3.00 — top up at least RM 22.00.');
    expect(plan({ amount: -10 }, totals(1000, -200))).toMatchObject({ balanceAfterCents: 0, bonusAfterCents: 0 });
  });
});
