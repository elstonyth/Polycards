import { describe, it, expect } from 'vitest';
import { walletSplit } from '../wallet-split';

const sen = (n: number) => Math.round(n * 100);

describe('walletSplit — Balance / Withdrawable / For packs', () => {
  it('splits For packs into bonus credit and still to use', () => {
    // RM 125 balance, RM 30 withdrawable, RM 15 of it bonus.
    expect(
      walletSplit({
        available: 125,
        withdrawable: 30,
        bonus: 15,
        remaining: 80,
        hasTopup: true,
      }),
    ).toEqual({ forPacks: 95, bonus: 15, stillToUse: 80, afterTopup: 0 });
  });

  it('never topped up: only bonus and stamped sales are for packs', () => {
    // RM 40 balance: RM 10 bonus, RM 12 stamped (bonus-share / welcome card),
    // RM 18 unstamped — withdrawable at the first top-up.
    expect(
      walletSplit({
        available: 40,
        withdrawable: 0,
        bonus: 10,
        remaining: 12,
        hasTopup: false,
      }),
    ).toEqual({ forPacks: 22, bonus: 10, stillToUse: 12, afterTopup: 18 });
  });

  it('never topped up: an unstamped RM 30 prize sale and RM 15 bonus', () => {
    expect(
      walletSplit({
        available: 45,
        withdrawable: 0,
        bonus: 15,
        remaining: 0,
        hasTopup: false,
      }),
    ).toEqual({ forPacks: 15, bonus: 15, stillToUse: 0, afterTopup: 30 });
  });

  it('never topped up: remaining above the balance stays inside it', () => {
    expect(
      walletSplit({
        available: 20,
        withdrawable: 0,
        bonus: 5,
        remaining: 999,
        hasTopup: false,
      }),
    ).toEqual({ forPacks: 20, bonus: 5, stillToUse: 15, afterTopup: 0 });
  });

  it('topped up: remaining above the balance stays inside it (delivery fee)', () => {
    // Backend clamps withdrawable at 0; For packs is the balance, not remaining.
    expect(
      walletSplit({
        available: 20,
        withdrawable: 0,
        bonus: 0,
        remaining: 35,
        hasTopup: true,
      }),
    ).toEqual({ forPacks: 20, bonus: 0, stillToUse: 20, afterTopup: 0 });
  });

  it('frozen: available 0 caps bonus at For packs, so all read 0', () => {
    expect(
      walletSplit({
        available: 0,
        withdrawable: 0,
        bonus: 15,
        remaining: 10,
        hasTopup: true,
      }),
    ).toEqual({ forPacks: 0, bonus: 0, stillToUse: 0, afterTopup: 0 });
  });

  it('works in sen, so float noise never prints', () => {
    // 0.3 - 0.1 === 0.19999999999999998 in floats.
    expect(
      walletSplit({
        available: 0.3,
        withdrawable: 0.1,
        bonus: 0.1,
        remaining: 0,
        hasTopup: true,
      }),
    ).toEqual({ forPacks: 0.2, bonus: 0.1, stillToUse: 0.1, afterTopup: 0 });
  });

  it('never shows a negative For packs', () => {
    expect(
      walletSplit({
        available: 10,
        withdrawable: 12,
        bonus: 0,
        remaining: 0,
        hasTopup: true,
      }),
    ).toEqual({ forPacks: 0, bonus: 0, stillToUse: 0, afterTopup: 0 });
  });

  it('reads NaN and negative inputs as 0', () => {
    expect(
      walletSplit({
        available: NaN,
        withdrawable: NaN,
        bonus: NaN,
        remaining: NaN,
        hasTopup: false,
      }),
    ).toEqual({ forPacks: 0, bonus: 0, stillToUse: 0, afterTopup: 0 });
    // A negative withdrawable must not inflate For packs past the balance.
    expect(
      walletSplit({
        available: 50,
        withdrawable: -20,
        bonus: -5,
        remaining: -1,
        hasTopup: true,
      }),
    ).toEqual({ forPacks: 50, bonus: 0, stillToUse: 50, afterTopup: 0 });
  });

  it('Balance = withdrawable + after top-up + For packs, and For packs = bonus + still to use', () => {
    const cases = [
      { available: 125, withdrawable: 30, bonus: 15, remaining: 80 },
      { available: 0, withdrawable: 0, bonus: 15, remaining: 0 },
      { available: 12.34, withdrawable: 0, bonus: 99.99, remaining: 3 },
      { available: 0.3, withdrawable: 0.1, bonus: 0.1, remaining: 0.05 },
      { available: 45, withdrawable: 0, bonus: 15, remaining: 0 },
      { available: 7.77, withdrawable: 1.11, bonus: 2.22, remaining: 1.01 },
      { available: 80.97, withdrawable: 0, bonus: 0, remaining: 20.5 },
    ];
    for (const c of cases) {
      for (const hasTopup of [true, false]) {
        const s = walletSplit({ ...c, hasTopup });
        expect(sen(c.withdrawable) + sen(s.afterTopup) + sen(s.forPacks)).toBe(
          Math.max(sen(c.available), sen(c.withdrawable)),
        );
        expect(sen(s.bonus) + sen(s.stillToUse)).toBe(sen(s.forPacks));
        if (hasTopup) expect(s.afterTopup).toBe(0);
        for (const v of Object.values(s)) expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
