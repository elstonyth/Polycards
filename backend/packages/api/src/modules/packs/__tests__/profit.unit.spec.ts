import {
  keptCents,
  profitActivity,
  profitCash,
  profitOwed,
  type CashCents,
  type CashSide,
  type OwedCents,
} from '../profit';

const side = (n: number, g: number, f: number, m = 0, mg = 0): CashSide => ({
  count: n,
  grossCents: g,
  feeCents: f,
  missingFees: m,
  missingGross: mg,
});
const cash = (t: CashSide, w: CashSide, fxCents = 0): CashCents => ({
  topups: t,
  withdrawals: w,
  fxCents,
});

describe('profit fold', () => {
  it('cash kept = top-ups − fees both ways − withdrawals + the FX spread, and can go negative', () => {
    const c = cash(side(3, 30000, 450), side(1, 50000, 100), 320);
    expect(keptCents(c)).toBe(30000 - 450 - 50000 - 100 + 320);
    expect(profitCash(c, null).previous_kept).toBeNull();
    expect(profitCash(c, c).previous_kept).toBe(-202.3);
    expect(profitCash(c, null)).toMatchObject({
      topups: {
        count: 3,
        gross: 300,
        fees: 4.5,
        missing_fees: 0,
        missing_gross: 0,
      },
      withdrawals: {
        count: 1,
        gross: 500,
        fees: 1,
        missing_fees: 0,
        missing_gross: 0,
      },
      fx_earned: 3.2,
      kept: -202.3,
    });
  });

  it('owed = wallets + payouts and commission not yet paid + cards at sell-back; shipped cards are a cost, not owed', () => {
    const owed: OwedCents = {
      walletCashCents: 10000,
      payoutsInFlightCents: 2500,
      commissionUnpaidCents: 1500,
      walletBonusCents: 500,
      walletNoTopupCents: 700,
      cardCount: 3,
      deliveringCount: 1,
      cardSellbackCents: 9000,
      cardNoTopupCount: 2,
      cardNoTopupCents: 4000,
      shippedCount: 4,
      shippedCents: 20000,
    };
    const all = cash(side(5, 100000, 0), side(2, 20000, 0));
    expect(profitOwed(owed, all)).toEqual({
      wallet_cash: 100,
      wallet_bonus: 5,
      wallet_no_topup: 7,
      payouts_in_flight: 25,
      commission_unpaid: 15,
      cards: { count: 3, delivering: 1, sellback: 90 },
      cards_no_topup: { count: 2, sellback: 40 },
      total: 230, // 100 + 25 + 15 + 90; never-topped-up cards excluded
      all_time_kept: 800,
      shipped: { count: 4, value: 200 },
      if_all_cashed_out: 370, // 800 − 230 − 200
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
    const c = cash(side(2, 5000, 0, 1, 1), side(0, 0, 0));
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
