import { playthroughState } from '../withdrawable';

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
