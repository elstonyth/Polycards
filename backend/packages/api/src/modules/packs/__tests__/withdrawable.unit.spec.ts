import {
  playthroughState,
  withdrawableCents,
  withdrawalGateError,
  withdrawalHold,
  type WithdrawalGateWallet,
} from '../withdrawable';

describe('playthroughState (withdrawal playthrough gate)', () => {
  it('deposit 100, used 100 -> withdrawable', () => {
    expect(playthroughState({ depositedCents: 10000, usedCents: 10000 })).toEqual({
      withdrawable: true,
      remainingCents: 0,
    });
  });

  it('deposit 20, used 0 -> locked with RM20 remaining', () => {
    expect(playthroughState({ depositedCents: 2000, usedCents: 0 })).toEqual({
      withdrawable: false,
      remainingCents: 2000,
    });
  });

  it('deposit 100, used 50, sold card 100 (balance 150) -> still locked', () => {
    // Buyback credits never enter usedCents — only pack_open spend does.
    expect(playthroughState({ depositedCents: 10000, usedCents: 5000 })).toEqual({
      withdrawable: false,
      remainingCents: 5000,
    });
  });

  it('never deposited -> withdrawable (nothing to play through)', () => {
    expect(playthroughState({ depositedCents: 0, usedCents: 0 })).toEqual({
      withdrawable: true,
      remainingCents: 0,
    });
  });

  it('over-used beyond deposits stays withdrawable, remaining clamps at 0', () => {
    expect(playthroughState({ depositedCents: 10000, usedCents: 25000 })).toEqual({
      withdrawable: true,
      remainingCents: 0,
    });
  });
});

// Spend first (2026-10-15, ADR 0013): while anything is still to use on
// packs, nothing may leave; once it is all used, everything but bonus may.
// This replaces ADR 0011's partial hold.
describe('withdrawableCents (spend first)', () => {
  const w = (availableCents: number, bonusCents: number, remainingCents: number) =>
    withdrawableCents({ availableCents, bonusCents, remainingCents });

  it('nothing leaves while any money is still to use on packs', () => {
    expect(w(3895, 0, 1055)).toBe(0);
    // A RM 1,000 card sale, then a RM 500 top-up: all of it waits.
    expect(w(150000, 0, 50000)).toBe(0);
    expect(w(10000, 1500, 1)).toBe(0);
  });

  it('once it is all used, everything but bonus credit may leave', () => {
    expect(w(5000, 0, 0)).toBe(5000);
    expect(w(10000, 1500, 0)).toBe(8500);
  });

  it('bonus credit alone never leaves', () => {
    expect(w(1500, 1500, 0)).toBe(0);
  });

  it('clamps at 0 when bonus exceeds the balance', () => {
    expect(w(800, 1000, 0)).toBe(0);
  });
});

describe('withdrawalGateError (spend first, 2026-10-15)', () => {
  const wallet = (over: Partial<WithdrawalGateWallet>): WithdrawalGateWallet => ({
    withdrawable: 0,
    isFrozen: false,
    hasTopup: true,
    bonus: 0,
    playthrough: { remaining: 0 },
    ...over,
  });

  it('while money is still to use on packs, says how much more to spend', () => {
    const err = withdrawalGateError(wallet({ playthrough: { remaining: 10.55 } }), 5);
    expect(err?.message).toBe(
      "Withdrawals unlock once you've used RM 10.55 more on packs. Then your balance, except bonus credit, can be withdrawn.",
    );
    expect(err?.type).toBe('not_allowed');
  });

  it('counts bonus credit in, because packs spend it first', () => {
    const err = withdrawalGateError(
      wallet({ bonus: 15, playthrough: { remaining: 30 } }),
      5,
    );
    expect(err?.message).toContain('used RM 45.00 more on packs');
  });

  it('prints the amount cents-exact', () => {
    const err = withdrawalGateError(
      wallet({ bonus: 0.1, playthrough: { remaining: 0.2 } }),
      5,
    );
    expect(err?.message).toContain('RM 0.30 more on packs');
  });

  it('keeps the plain cap once nothing is left to use on packs', () => {
    const err = withdrawalGateError(wallet({ withdrawable: 50, bonus: 20 }), 60);
    expect(err?.message).toBe('You can withdraw up to RM 50.00 right now.');
  });

  it('freeze and no top-up still come first', () => {
    expect(
      withdrawalGateError(
        wallet({ isFrozen: true, playthrough: { remaining: 10 } }),
        5,
      )?.message,
    ).toMatch(/under review/);
    expect(
      withdrawalGateError(
        wallet({ hasTopup: false, playthrough: { remaining: 10 } }),
        5,
      )?.message,
    ).toBe(
      'Top up at least once to unlock deliveries. To withdraw, you also need to use all your money for packs.',
    );
  });

  it('allows an amount within what is withdrawable', () => {
    expect(withdrawalGateError(wallet({ withdrawable: 28.4 }), 28.4)).toBeNull();
  });

  it('refuses while money is still to use on packs, even if withdrawable disagrees', () => {
    const err = withdrawalGateError(
      wallet({ withdrawable: 50, playthrough: { remaining: 10 } }),
      20,
    );
    expect(err?.message).toMatch(/^Withdrawals unlock once you've used RM 10\.00 more on packs\./);
  });
});

// The hold the storefront shows, named here so it is never re-derived there
// (architecture review 2026-11-17). Same order as the refusals below.
describe('withdrawalHold', () => {
  const hold = (over: Partial<WithdrawalGateWallet>) =>
    withdrawalHold({
      withdrawable: 0,
      isFrozen: false,
      hasTopup: true,
      bonus: 0,
      playthrough: { remaining: 0 },
      ...over,
    });

  it('is null once nothing is left to use on packs', () => {
    expect(hold({ withdrawable: 30, bonus: 5 })).toEqual({
      hold: null,
      unlockSpend: 0,
    });
  });

  it('is locked while money is still to use on packs, with bonus counted in', () => {
    expect(hold({ bonus: 15, playthrough: { remaining: 30 } })).toEqual({
      hold: 'locked',
      unlockSpend: 45,
    });
    // Cents-exact, as the refusal prints it.
    expect(hold({ bonus: 0.1, playthrough: { remaining: 0.2 } }).unlockSpend).toBe(0.3);
  });

  it('ignores a sub-sen remainder, as the gate does', () => {
    expect(hold({ playthrough: { remaining: 0.004 } }).hold).toBeNull();
  });

  it('freeze outranks no top-up, which outranks locked', () => {
    const all = { isFrozen: true, hasTopup: false, playthrough: { remaining: 10 } };
    expect(hold(all)).toEqual({ hold: 'frozen', unlockSpend: 0 });
    expect(hold({ ...all, isFrozen: false })).toEqual({
      hold: 'no_topup',
      unlockSpend: 0,
    });
    expect(hold({ ...all, isFrozen: false, hasTopup: true }).hold).toBe('locked');
  });
});

describe('withdrawalGateError codes', () => {
  const wallet = (over: Partial<WithdrawalGateWallet>): WithdrawalGateWallet => ({
    withdrawable: 0,
    isFrozen: false,
    hasTopup: true,
    bonus: 0,
    playthrough: { remaining: 0 },
    ...over,
  });

  it.each([
    [{ isFrozen: true }, 'frozen'],
    [{ hasTopup: false }, 'no_topup'],
    [{ playthrough: { remaining: 10 } }, 'locked'],
    [{ withdrawable: 5 }, 'over_limit'],
  ] as const)('%j refuses with code %s', (over, code) => {
    expect(withdrawalGateError(wallet(over), 20)?.code).toBe(code);
  });

  // Defense in depth: a disagreeing `withdrawable` never lets money still to
  // use on packs leave, whichever hold outranks the lock.
  it.each([
    [{ isFrozen: true }, 'frozen'],
    [{ hasTopup: false }, 'no_topup'],
    [{}, 'locked'],
  ] as const)('%j with money left for packs refuses (%s) even if withdrawable disagrees', (over, code) => {
    const err = withdrawalGateError(
      wallet({ ...over, withdrawable: 50, playthrough: { remaining: 10 } }),
      20,
    );
    expect(err?.code).toBe(code);
  });

  it('the code matches the hold the wallet reports', () => {
    for (const over of [
      { isFrozen: true },
      { hasTopup: false },
      { playthrough: { remaining: 10 } },
    ]) {
      expect(withdrawalGateError(wallet(over), 20)?.code).toBe(
        withdrawalHold(wallet(over)).hold,
      );
    }
  });
});
