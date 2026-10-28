import { describe, it, expect } from 'vitest';
import {
  isWithdrawLocked,
  sen,
  stepTwoCopy,
  walletSplit,
} from '../wallet-split';

// Helper strings keep "RM" and the figure on one line.
const NB = ' ';

describe('walletSplit — Balance / Withdrawable / For packs', () => {
  it('slab RM 300 sold, RM 50 top-up unspent: all locked until it is used', () => {
    expect(
      walletSplit({ available: 350, withdrawable: 0, bonus: 0, remaining: 50 }),
    ).toEqual({
      forPacks: 50,
      bonus: 0,
      stillToUse: 50,
      lockedCash: 300,
      unlockSpend: 50,
    });
  });

  it('after the RM 50 is spent: the backend says withdrawable, nothing locked', () => {
    expect(
      walletSplit({
        available: 300,
        withdrawable: 300,
        bonus: 0,
        remaining: 0,
      }),
    ).toEqual({
      forPacks: 0,
      bonus: 0,
      stillToUse: 0,
      lockedCash: 0,
      unlockSpend: 0,
    });
  });

  it('locked with bonus credit: bonus never counts as locked cash, but packs spend it first', () => {
    expect(
      walletSplit({
        available: 125,
        withdrawable: 0,
        bonus: 15,
        remaining: 80,
      }),
    ).toEqual({
      forPacks: 95,
      bonus: 15,
      stillToUse: 80,
      lockedCash: 30,
      unlockSpend: 95,
    });
  });

  it('non-bonus balance 0 with money still to use: nothing locked, the spend stays whole', () => {
    // A delivery fee took the cash; RM 20 is still owed to packs.
    expect(
      walletSplit({ available: 10, withdrawable: 0, bonus: 10, remaining: 20 }),
    ).toEqual({
      forPacks: 10,
      bonus: 10,
      stillToUse: 0,
      lockedCash: 0,
      unlockSpend: 30,
    });
  });

  it('remaining above the non-bonus balance: capped on screen, uncapped to unlock', () => {
    expect(
      walletSplit({ available: 20, withdrawable: 0, bonus: 5, remaining: 35 }),
    ).toEqual({
      forPacks: 20,
      bonus: 5,
      stillToUse: 15,
      lockedCash: 0,
      unlockSpend: 40,
    });
  });

  it('never topped up: an unstamped RM 30 prize sale and RM 15 bonus', () => {
    expect(
      walletSplit({ available: 45, withdrawable: 0, bonus: 15, remaining: 0 }),
    ).toEqual({
      forPacks: 15,
      bonus: 15,
      stillToUse: 0,
      lockedCash: 30,
      unlockSpend: 15,
    });
  });

  it('an older backend with a partial hold: nothing is called locked', () => {
    // Pre-spend-first gate: withdrawable = available − bonus − remaining.
    expect(
      walletSplit({
        available: 125,
        withdrawable: 30,
        bonus: 15,
        remaining: 80,
      }),
    ).toMatchObject({ forPacks: 95, stillToUse: 80, lockedCash: 0 });
  });

  it('frozen: available 0 caps the figures at 0', () => {
    expect(
      walletSplit({ available: 0, withdrawable: 0, bonus: 15, remaining: 10 }),
    ).toMatchObject({ forPacks: 0, bonus: 0, stillToUse: 0, lockedCash: 0 });
  });

  it('works in sen, so float noise never prints', () => {
    // 0.3 - 0.1 === 0.19999999999999998 in floats.
    expect(
      walletSplit({
        available: 0.3,
        withdrawable: 0,
        bonus: 0.1,
        remaining: 0.1,
      }),
    ).toEqual({
      forPacks: 0.2,
      bonus: 0.1,
      stillToUse: 0.1,
      lockedCash: 0.1,
      unlockSpend: 0.2,
    });
  });

  it('reads NaN and negative inputs as 0', () => {
    expect(
      walletSplit({
        available: NaN,
        withdrawable: NaN,
        bonus: NaN,
        remaining: NaN,
      }),
    ).toEqual({
      forPacks: 0,
      bonus: 0,
      stillToUse: 0,
      lockedCash: 0,
      unlockSpend: 0,
    });
    expect(
      walletSplit({
        available: 50,
        withdrawable: -20,
        bonus: -5,
        remaining: -1,
      }),
    ).toMatchObject({ forPacks: 0, lockedCash: 50, unlockSpend: 0 });
  });

  it('Balance = withdrawable + withdrawable later + bonus + still to use, for every backend state', () => {
    type Backend = 'spend-first' | 'partial-hold';
    // withdrawable.ts. spend-first: 0 before a top-up, while frozen, or while
    // anything is still to use; else everything but bonus. partial-hold (the
    // pre-2026-10-15 backend): available − bonus − remaining.
    const backend = (
      model: Backend,
      available: number,
      bonus: number,
      remaining: number,
      hasTopup: boolean,
      frozen: boolean,
    ) => {
      if (!hasTopup || frozen) return 0;
      const rest = Math.max(0, sen(available) - sen(bonus));
      if (model === 'partial-hold')
        return Math.max(0, rest - sen(remaining)) / 100;
      return sen(remaining) > 0 ? 0 : rest / 100;
    };
    const amounts = [0, 0.01, 0.3, 7.77, 15, 45, 350.55];
    for (const model of ['spend-first', 'partial-hold'] as Backend[])
      for (const balance of amounts)
        // bonus may exceed what is left after a delivery fee.
        for (const bonus of [...amounts, 999])
          for (const remaining of [0, 0.1, 12.34, 50, 999])
            for (const hasTopup of [true, false])
              for (const frozen of [false, true]) {
                const available = frozen ? 0 : balance;
                const withdrawable = backend(
                  model,
                  available,
                  bonus,
                  remaining,
                  hasTopup,
                  frozen,
                );
                const s = walletSplit({
                  available,
                  withdrawable,
                  bonus,
                  remaining,
                });
                expect(
                  sen(withdrawable) +
                    sen(s.lockedCash) +
                    sen(s.bonus) +
                    sen(s.stillToUse),
                ).toBe(sen(available));
                expect(sen(s.bonus) + sen(s.stillToUse)).toBe(sen(s.forPacks));
                expect(sen(s.unlockSpend)).toBe(sen(bonus) + sen(remaining));
                // Locked exactly when the backend shuts the whole gate.
                expect(
                  isWithdrawLocked({
                    hasTopup,
                    isFrozen: frozen,
                    remaining,
                    withdrawable,
                  }),
                ).toBe(
                  hasTopup &&
                    !frozen &&
                    sen(remaining) > 0 &&
                    sen(withdrawable) === 0,
                );
                if (model === 'spend-first')
                  expect(
                    isWithdrawLocked({
                      hasTopup,
                      isFrozen: frozen,
                      remaining,
                      withdrawable,
                    }),
                  ).toBe(hasTopup && !frozen && sen(remaining) > 0);
                for (const v of Object.values(s))
                  expect(v).toBeGreaterThanOrEqual(0);
              }
  });
});

describe('isWithdrawLocked — matches the backend gate', () => {
  const base = {
    hasTopup: true,
    isFrozen: false,
    remaining: 50,
    withdrawable: 0,
  };

  it('locks a topped-up account with money still to use and nothing withdrawable', () => {
    expect(isWithdrawLocked(base)).toBe(true);
  });

  it('frozen or never topped up outranks locked', () => {
    expect(isWithdrawLocked({ ...base, isFrozen: true })).toBe(false);
    expect(isWithdrawLocked({ ...base, hasTopup: false })).toBe(false);
  });

  it('judges zero in sen', () => {
    expect(isWithdrawLocked({ ...base, remaining: 0 })).toBe(false);
    expect(isWithdrawLocked({ ...base, remaining: 0.004 })).toBe(false);
    // A float hair of withdrawable is still nothing withdrawable.
    expect(isWithdrawLocked({ ...base, withdrawable: 0.004 })).toBe(true);
  });

  it('an older backend that still pays part out is not locked', () => {
    expect(isWithdrawLocked({ ...base, withdrawable: 30 })).toBe(false);
  });
});

describe('stepTwoCopy', () => {
  it('topped up: names the spend, nothing else when there is no bonus', () => {
    expect(
      stepTwoCopy({ hasTopup: true, available: 350, bonus: 0, remaining: 50 }),
    ).toEqual({ title: `Use RM${NB}50.00 more on packs`, notes: [] });
  });

  it('topped up with bonus credit: the spend includes it, keyed on the raw bonus', () => {
    expect(
      stepTwoCopy({ hasTopup: true, available: 125, bonus: 15, remaining: 80 }),
    ).toEqual({
      title: `Use RM${NB}95.00 more on packs`,
      notes: [
        `This includes your RM${NB}15.00 bonus credit, which packs use first.`,
      ],
    });
    // Bonus above the balance (frozen read, or a fee took the cash) still
    // names the whole bonus the packs must take.
    expect(
      stepTwoCopy({ hasTopup: true, available: 10, bonus: 25, remaining: 0 })
        .notes[0],
    ).toBe(
      `This includes your RM${NB}25.00 bonus credit, which packs use first.`,
    );
  });

  it('remaining above the cash beside the bonus: delivery fees do not count', () => {
    expect(
      stepTwoCopy({ hasTopup: true, available: 10, bonus: 10, remaining: 20 }),
    ).toEqual({
      title: `Use RM${NB}30.00 more on packs`,
      notes: [
        `This includes your RM${NB}10.00 bonus credit, which packs use first.`,
        'Delivery fees don’t count as pack spending.',
      ],
    });
  });

  it('never topped up, nothing owed yet: just the top-up', () => {
    expect(
      stepTwoCopy({ hasTopup: false, available: 30, bonus: 0, remaining: 0 }),
    ).toEqual({ title: 'Use your top-up on packs', notes: [] });
  });

  it('never topped up with money for packs: the top-up plus that money', () => {
    expect(
      stepTwoCopy({
        hasTopup: false,
        available: 80.97,
        bonus: 0,
        remaining: 20.5,
      }),
    ).toEqual({
      title: 'Use your top-up on packs',
      notes: [`Plus RM${NB}20.50 you already have for packs.`],
    });
  });

  it('never topped up, only bonus for packs: names the bonus once', () => {
    expect(
      stepTwoCopy({ hasTopup: false, available: 45, bonus: 15, remaining: 0 }),
    ).toEqual({
      title: 'Use your top-up on packs',
      notes: [`Plus your RM${NB}15.00 bonus credit, which packs use first.`],
    });
  });

  it('never topped up, bonus and other money for packs: one combined line', () => {
    expect(
      stepTwoCopy({ hasTopup: false, available: 60, bonus: 15, remaining: 20 }),
    ).toEqual({
      title: 'Use your top-up on packs',
      notes: [
        `Plus RM${NB}35.00 you already have for packs, including your RM${NB}15.00 bonus credit, which packs use first.`,
      ],
    });
  });
});
