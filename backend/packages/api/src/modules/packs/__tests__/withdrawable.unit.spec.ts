import {
  playthroughState,
  withdrawableCents,
  withdrawalGateError,
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

// Partial unlock (2026-10-14, ADR 0011): only the part still to play through
// is held. Before, the gate was all-or-nothing, so a RM 10.55 bonus-share
// sell-back locked a customer's whole RM 38.95 wallet.
describe('withdrawableCents (partial unlock)', () => {
  const w = (availableCents: number, bonusCents: number, remainingCents: number) =>
    withdrawableCents({ availableCents, bonusCents, remainingCents });

  it('holds only what is still to play: the 2026-10-14 ticket', () => {
    expect(w(3895, 0, 1055)).toBe(2840);
  });

  it('deposit 100, used 50, sold 100: the 100 of winnings may leave', () => {
    expect(w(15000, 0, 5000)).toBe(10000);
  });

  it('a top-up no longer locks winnings that were already free', () => {
    // RM 22 withdrawable, then a RM 50 top-up: the RM 50 is held, the RM 22 is not.
    expect(w(7200, 0, 5000)).toBe(2200);
  });

  it('bonus credit stays out on top of the playthrough hold', () => {
    expect(w(10000, 1500, 2000)).toBe(6500);
  });

  it('clamps at 0 when the holds exceed the balance', () => {
    // A delivery fee spends normal money and can go below the still-to-play part.
    expect(w(800, 0, 1055)).toBe(0);
  });

  it('fully played through: everything but bonus', () => {
    expect(w(5000, 0, 0)).toBe(5000);
  });
});

describe('withdrawalGateError playthrough refusal', () => {
  const wallet = (over: Partial<WithdrawalGateWallet>): WithdrawalGateWallet => ({
    withdrawable: 0,
    isFrozen: false,
    hasTopup: true,
    playthrough: { remaining: 0 },
    ...over,
  });

  it('names what may leave now and what is still to play', () => {
    const err = withdrawalGateError(
      wallet({ withdrawable: 28.4, playthrough: { remaining: 10.55 } }),
      38.95,
    );
    expect(err?.message).toBe(
      'You can withdraw up to RM 28.40. Spend RM 10.55 more on packs to unlock the rest.',
    );
  });

  it('with nothing free yet, says only what is still to play', () => {
    const err = withdrawalGateError(
      wallet({ withdrawable: 0, playthrough: { remaining: 60 } }),
      50,
    );
    expect(err?.message).toBe('Spend RM 60.00 more on packs to unlock withdrawals.');
  });

  it('allows an amount within the partial withdrawable', () => {
    expect(
      withdrawalGateError(wallet({ withdrawable: 28.4, playthrough: { remaining: 10.55 } }), 28.4),
    ).toBeNull();
  });
});
