import { assetsSection, floatingSection, type WalletRow } from '../pnl-balance';

const wallet = (w: Partial<WalletRow>): WalletRow => ({
  balance_sen: 0,
  bonus_sen: 0,
  deposited_sen: 0,
  used_sen: 0,
  has_topup: true,
  frozen: false,
  ...w,
});

const SOURCES = {
  adjustment: 0,
  checkin: 0,
  task: 0,
  weekly_challenge: 0,
  returned: 0,
  lucky_draw: 0,
  other: 0,
};
const NO_CARDS = {
  vault: { cards: 0, sen: 0 },
  processing: { cards: 0, sen: 0 },
};

describe('assetsSection', () => {
  it('values unsold stock (on hand − requested − ready to ship) at weighted-average cost', () => {
    const s = assetsSection(
      [
        { handle: 'a', on_hand: 10, requested: 2, ready_to_ship: 3 },
        { handle: 'b', on_hand: 1, requested: 0, ready_to_ship: 0 },
      ],
      new Map([
        ['a', 12.5],
        ['b', 100],
      ]),
    );
    expect(s).toEqual({
      total_sen: 5 * 1250 + 10000,
      cards: 6,
      no_cost_cards: 0,
    });
  });

  it('never lets an over-reserved card go negative', () => {
    const s = assetsSection(
      [
        { handle: 'a', on_hand: 2, requested: 3, ready_to_ship: 1 },
        { handle: 'b', on_hand: -1, requested: 0, ready_to_ship: 0 },
      ],
      new Map([
        ['a', 10],
        ['b', 10],
      ]),
    );
    expect(s).toEqual({ total_sen: 0, cards: 0, no_cost_cards: 0 });
  });

  it('counts cards with no supplier cost without valuing them; a cost of 0 is a real cost', () => {
    const s = assetsSection(
      [
        { handle: 'free', on_hand: 4, requested: 0, ready_to_ship: 0 },
        { handle: 'unknown', on_hand: 3, requested: 1, ready_to_ship: 0 },
        { handle: 'missing', on_hand: 1, requested: 0, ready_to_ship: 0 },
      ],
      new Map([
        ['free', 0],
        ['unknown', null],
      ]),
    );
    expect(s).toEqual({ total_sen: 0, cards: 7, no_cost_cards: 3 });
  });
});

describe('floatingSection', () => {
  it('lets a played-through customer withdraw everything but bonus', () => {
    const s = floatingSection(
      [
        wallet({
          balance_sen: 15000,
          bonus_sen: 5000,
          deposited_sen: 10000,
          used_sen: 10000,
        }),
      ],
      { ...SOURCES, adjustment: 5000 },
      NO_CARDS,
    );
    expect(s.wallet).toEqual({
      withdrawable_sen: 10000,
      free_credit_sen: 5000,
      free_credit_by_source: { ...SOURCES, adjustment: 5000 },
      locked_sen: 0,
      non_withdrawable_sen: 5000,
      total_sen: 15000,
    });
  });

  it('locks all cash while money is still to play through, when frozen, or with no top-up', () => {
    const s = floatingSection(
      [
        // still RM 20 to use on packs
        wallet({ balance_sen: 10000, deposited_sen: 5000, used_sen: 3000 }),
        // played through but frozen
        wallet({ balance_sen: 7000, bonus_sen: 1000, frozen: true }),
        // never topped up
        wallet({ balance_sen: 4000, has_topup: false }),
      ],
      { ...SOURCES, task: 1000 },
      NO_CARDS,
    );
    expect(s.wallet.withdrawable_sen).toBe(0);
    expect(s.wallet.free_credit_sen).toBe(1000);
    expect(s.wallet.locked_sen).toBe(10000 + 6000 + 4000);
    expect(s.wallet.non_withdrawable_sen).toBe(21000);
    expect(s.wallet.total_sen).toBe(21000);
  });

  it('adds customers up and never counts a negative balance or bonus', () => {
    const s = floatingSection(
      [
        wallet({ balance_sen: 2000 }),
        wallet({ balance_sen: 500, bonus_sen: 300 }),
        wallet({ balance_sen: -800 }),
        wallet({ balance_sen: 100, bonus_sen: -50 }),
      ],
      { ...SOURCES, returned: 300 },
      NO_CARDS,
    );
    expect(s.wallet.withdrawable_sen).toBe(2000 + 200 + 100);
    expect(s.wallet.free_credit_sen).toBe(300);
    // normal part of the last one is 150 (100 − −50): 100 withdrawable, 50 locked
    expect(s.wallet.locked_sen).toBe(50);
    expect(s.wallet.total_sen).toBe(2000 + 500 + 150);
  });

  it('shows vault and order-processing cards as two lines, then wallet + cards', () => {
    const s = floatingSection([wallet({ balance_sen: 1000 })], SOURCES, {
      vault: { cards: 3, sen: 4500 },
      processing: { cards: 1, sen: 900 },
    });
    expect(s.cards).toEqual({
      vault: { cards: 3, sen: 4500 },
      processing: { cards: 1, sen: 900 },
      total_sen: 5400,
    });
    expect(s.total_sen).toBe(1000 + 5400);
  });

  it('is all zeros with no customers', () => {
    const s = floatingSection([], SOURCES, NO_CARDS);
    expect(s.total_sen).toBe(0);
    expect(s.wallet.total_sen).toBe(0);
    expect(s.cards.total_sen).toBe(0);
  });
});
