import { describe, it, expect } from 'vitest';
import {
  isWithdrawLocked,
  topupFirstLine,
  unlockLine,
  walletSplit,
} from '../wallet-split';

const sen = (n: number) => Math.round(n * 100);

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

  it('Balance = withdrawable + locked cash + bonus + still to use, for every backend state', () => {
    // The backend gate (withdrawable.ts): 0 before a top-up or while anything
    // is still to use on packs, else everything but bonus.
    const backendWithdrawable = (
      available: number,
      bonus: number,
      remaining: number,
      hasTopup: boolean,
    ) =>
      !hasTopup || sen(remaining) > 0
        ? 0
        : Math.max(0, sen(available) - sen(bonus)) / 100;
    const amounts = [0, 0.01, 0.3, 7.77, 15, 45, 350.55];
    for (const available of amounts)
      for (const bonus of amounts.filter((b) => b <= available))
        for (const remaining of [0, 0.1, 12.34, 50, 999])
          for (const hasTopup of [true, false]) {
            const withdrawable = backendWithdrawable(
              available,
              bonus,
              remaining,
              hasTopup,
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
            // Locked exactly when the backend says so.
            expect(
              isWithdrawLocked({
                hasTopup,
                isFrozen: false,
                remaining,
                withdrawable,
              }),
            ).toBe(hasTopup && sen(remaining) > 0);
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

  it('nothing left to use (to the sen) is not locked', () => {
    expect(isWithdrawLocked({ ...base, remaining: 0 })).toBe(false);
    expect(isWithdrawLocked({ ...base, remaining: 0.004 })).toBe(false);
  });

  it('an older backend that still pays part out is not locked', () => {
    expect(isWithdrawLocked({ ...base, withdrawable: 30 })).toBe(false);
  });
});

describe('unlockLine', () => {
  it('names the spend, the bonus-first rule and what the bank gets after', () => {
    expect(unlockLine({ unlockSpend: 95, bonus: 15, lockedCash: 30 })).toBe(
      'Spend RM 95.00 more on packs to unlock withdrawals (packs use bonus credit first). Then RM 30.00 can go to your bank.',
    );
  });

  it('drops the bracket with no bonus and the second sentence with nothing locked', () => {
    expect(unlockLine({ unlockSpend: 50, bonus: 0, lockedCash: 300 })).toBe(
      'Spend RM 50.00 more on packs to unlock withdrawals. Then RM 300.00 can go to your bank.',
    );
    expect(unlockLine({ unlockSpend: 20, bonus: 0, lockedCash: 0 })).toBe(
      'Spend RM 20.00 more on packs to unlock withdrawals.',
    );
  });
});

describe('topupFirstLine', () => {
  it('stamped money and cash waiting: names both', () => {
    expect(
      topupFirstLine({
        depositMinRm: 50,
        unlockSpend: 20.5,
        lockedCash: 60.47,
      }),
    ).toBe(
      'Top up once (from RM 50). Then spend your top-up plus RM 20.50 on packs to unlock withdrawals; after that, RM 60.47 can go to your bank. Card deliveries start after your first top-up.',
    );
  });

  it('drops "plus" with nothing owed and "after that" with nothing waiting', () => {
    expect(
      topupFirstLine({ depositMinRm: 50, unlockSpend: 0, lockedCash: 30 }),
    ).toBe(
      'Top up once (from RM 50). Then spend your top-up on packs to unlock withdrawals; after that, RM 30.00 can go to your bank. Card deliveries start after your first top-up.',
    );
    expect(
      topupFirstLine({ depositMinRm: 30, unlockSpend: 15, lockedCash: 0 }),
    ).toBe(
      'Top up once (from RM 30). Then spend your top-up plus RM 15.00 on packs to unlock withdrawals. Card deliveries start after your first top-up.',
    );
  });
});
