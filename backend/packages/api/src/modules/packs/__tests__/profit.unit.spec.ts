import {
  keptCents,
  profitActivity,
  profitCash,
  profitOwed,
  type CashSide,
} from '../profit';

const side = (
  n: number,
  g: number,
  f: number,
  m = 0,
  mg = 0,
): CashSide => ({
  count: n,
  grossCents: g,
  feeCents: f,
  missingFees: m,
  missingGross: mg,
});

describe('profit fold', () => {
  it('cash kept = top-ups − their fees − withdrawals − their fees, and can go negative', () => {
    const c = { topups: side(3, 30000, 450), withdrawals: side(1, 50000, 100) };
    expect(keptCents(c)).toBe(30000 - 450 - 50000 - 100);
    expect(profitCash(c, null).previous_kept).toBeNull();
    expect(profitCash(c, c).previous_kept).toBe(-205.5);
    expect(profitCash(c, null)).toMatchObject({
      topups: { count: 3, gross: 300, fees: 4.5, missing_fees: 0, missing_gross: 0 },
      withdrawals: { count: 1, gross: 500, fees: 1, missing_fees: 0, missing_gross: 0 },
      kept: -205.5,
    });
  });

  it('owed = wallet cash + payouts not yet paid + cards at sell-back; if-all-cashed-out uses all-time cash', () => {
    const owed = {
      walletCashCents: 10000,
      payoutsInFlightCents: 2500,
      walletBonusCents: 500,
      walletNoTopupCents: 700,
      cardCount: 3,
      deliveringCount: 1,
      cardSellbackCents: 9000,
    };
    const all = { topups: side(5, 100000, 0), withdrawals: side(2, 20000, 0) };
    expect(profitOwed(owed, all)).toEqual({
      wallet_cash: 100,
      wallet_bonus: 5,
      wallet_no_topup: 7,
      payouts_in_flight: 25,
      cards: { count: 3, delivering: 1, sellback: 90 },
      total: 215,
      all_time_kept: 800,
      if_all_cashed_out: 585,
    });
  });

  it('maps ledger reasons to activity lines with spend signs flipped', () => {
    expect(
      profitActivity([
        { reason: 'pack_open', amount: -300 },
        { reason: 'buyback', amount: 120 },
        { reason: 'bonus_grant', amount: 50 },
        { reason: 'daily_reward', amount: 5 },
        { reason: 'delivery_fee', amount: -15 },
        { reason: 'referral_commission', amount: 2 },
        { reason: 'adjustment', amount: -10 },
        { reason: 'topup', amount: 999 },
      ]),
    ).toEqual({
      pack_sales: 300,
      sellbacks: 120,
      promo_given: 55,
      delivery_fees: 15,
      referral_commission: 2,
      adjustments: -10,
    });
  });

  it('reports top-ups with no amount on file as missing gross', () => {
    const c = { topups: side(2, 5000, 0, 1, 1), withdrawals: side(0, 0, 0) };
    expect(profitCash(c, null).topups).toEqual({
      count: 2,
      gross: 50,
      fees: 0,
      missing_fees: 1,
      missing_gross: 1,
    });
  });

  it('missing reasons are zero, never NaN', () => {
    expect(profitActivity([])).toEqual({
      pack_sales: 0,
      sellbacks: 0,
      promo_given: 0,
      delivery_fees: 0,
      referral_commission: 0,
      adjustments: 0,
    });
  });
});
