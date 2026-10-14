import { describe, expect, it } from 'vitest';
import { standing } from './standing';

const money = (o: {
  gross: number;
  topupFees?: number;
  payoutFees?: number;
  paid: number;
  fx?: number;
  wallet?: number;
  inflight?: number;
  commission?: number;
  cards?: number;
  shipped?: number;
}) => {
  const fees = (o.topupFees ?? 0) + (o.payoutFees ?? 0);
  // Rounded to the sen, as the server sends it.
  const kept = Math.round((o.gross - fees - o.paid + (o.fx ?? 0)) * 100) / 100;
  const owed =
    (o.wallet ?? 0) + (o.inflight ?? 0) + (o.commission ?? 0) + (o.cards ?? 0);
  return {
    cash: {
      topups: { gross: o.gross, fees: o.topupFees ?? 0 },
      withdrawals: { gross: o.paid, fees: o.payoutFees ?? 0 },
      fx_earned: o.fx ?? 0,
      kept,
    },
    owed: {
      wallet_cash: o.wallet ?? 0,
      payouts_in_flight: o.inflight ?? 0,
      commission_unpaid: o.commission ?? 0,
      cards: { sellback: o.cards ?? 0 },
      shipped: { value: o.shipped ?? 0 },
      if_all_cashed_out:
        Math.round((kept - owed - (o.shipped ?? 0)) * 100) / 100,
    },
  };
};

describe('standing', () => {
  it('walks top-ups down to cash kept, then to "if they cashed out now"', () => {
    const s = standing(
      money({
        gross: 3000,
        topupFees: 40,
        payoutFees: 2.3,
        paid: 1850,
        wallet: 10,
        cards: 54.46,
      }),
    );
    expect(s.rows.map((r) => r.key)).toEqual([
      'topups',
      'fees',
      'withdrawals',
      'kept',
      'wallet',
      'cards',
      'shipped',
      'result',
    ]);
    expect(s.rows.map((r) => r.amount)).toEqual([
      3000, -42.3, -1850, 1107.7, -10, -54.46, 0, 1043.24,
    ]);
    const at = (k: string) => s.rows.find((r) => r.key === k)!;
    expect(at('topups')).toMatchObject({ left: 0, width: 100, tone: 'in' });
    // Each step comes off the right of what was left before it.
    expect(at('fees').left).toBeCloseTo(98.59);
    expect(at('withdrawals').left).toBeCloseTo(36.9233);
    expect(at('wallet').left).toBeCloseTo(36.59);
    expect(at('cards').left).toBeCloseTo(34.7747);
    expect(at('result')).toMatchObject({ left: 0, tone: 'kept', total: true });
    expect(at('result').width).toBeCloseTo(34.7747);
    expect(at('shipped').width).toBe(0);
  });

  // More out than in: the track scales to the larger side so every bar
  // fits, and a negative result is a loss.
  it('a player we lost money on', () => {
    const s = standing(money({ gross: 100, paid: 150, wallet: 20 }));
    const at = (k: string) => s.rows.find((r) => r.key === k)!;
    expect(at('topups').width).toBeCloseTo(58.8235);
    expect(at('withdrawals')).toMatchObject({ left: 0 });
    expect(at('withdrawals').width).toBeCloseTo(88.2353);
    expect(at('kept')).toMatchObject({ amount: -50, tone: 'loss' });
    expect(at('result')).toMatchObject({ amount: -70, tone: 'loss' });
    expect(at('result').width).toBeCloseTo(41.1765);
  });

  it('shows the FX spread, unpaid payouts and commission only when there are some', () => {
    const s = standing(
      money({ gross: 500, paid: 100, fx: 5, inflight: 25, commission: 3 }),
    );
    expect(s.rows.map((r) => r.key)).toEqual([
      'topups',
      'fees',
      'withdrawals',
      'fx',
      'kept',
      'wallet',
      'inflight',
      'commission',
      'cards',
      'shipped',
      'result',
    ]);
    expect(s.rows.find((r) => r.key === 'fx')).toMatchObject({
      amount: 5,
      tone: 'in',
    });
    // Nothing owed reads 0, never −0.
    expect(Object.is(s.rows.find((r) => r.key === 'wallet')!.amount, -0)).toBe(
      false,
    );
  });
});
