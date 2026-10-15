import { describe, expect, it } from 'vitest';
import { withdrawableNote } from './wallet-note';

const wallet = (o: Partial<Parameters<typeof withdrawableNote>[0]> = {}) => ({
  balance: 100,
  withdrawable: 100,
  bonus: 0,
  frozen: false,
  has_topup: true,
  playthrough: { deposited: 0, used: 0, remaining: 0 },
  ...o,
});

describe('withdrawableNote', () => {
  it('everything can leave: says so', () => {
    expect(withdrawableNote(wallet())).toEqual({ key: 'withdrawableNote' });
  });

  it('frozen and never-topped-up come first', () => {
    expect(withdrawableNote(wallet({ frozen: true, withdrawable: 0 }))).toEqual(
      {
        key: 'frozenNote',
      },
    );
    expect(
      withdrawableNote(wallet({ has_topup: false, withdrawable: 0 })),
    ).toEqual({ key: 'noTopupNote' });
  });

  // The production case (2026-10-14): RM 28.67 balance, RM 15 bonus and
  // RM 13.67 still to use on packs, so nothing can leave and the note must say why
  // instead of "can be withdrawn now".
  it('names what is held back and why', () => {
    expect(
      withdrawableNote(
        wallet({
          balance: 28.67,
          withdrawable: 0,
          bonus: 15,
          playthrough: { deposited: 6434.67, used: 6421, remaining: 13.67 },
        }),
      ),
    ).toEqual({ key: 'heldBoth', held: 28.67 });
    expect(
      withdrawableNote(wallet({ balance: 50, withdrawable: 35, bonus: 15 })),
    ).toEqual({ key: 'heldBonus', held: 15 });
    expect(
      withdrawableNote(
        wallet({
          balance: 50,
          withdrawable: 40,
          playthrough: { deposited: 20, used: 10, remaining: 10 },
        }),
      ),
    ).toEqual({ key: 'heldPlay', held: 10 });
  });

  it('held is rounded to the sen, never float noise', () => {
    expect(
      withdrawableNote(wallet({ balance: 0.3, withdrawable: 0.1, bonus: 0.2 })),
    ).toEqual({ key: 'heldBonus', held: 0.2 });
  });
});
