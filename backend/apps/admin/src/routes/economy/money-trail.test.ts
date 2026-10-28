import { describe, expect, it } from 'vitest';
import { moneyTrail } from './money-trail';

const cash = (
  topups: number,
  topupFees: number,
  out: number,
  outFees: number,
  fx = 0,
) => ({
  topups: { gross: topups, fees: topupFees },
  withdrawals: { gross: out, fees: outFees },
  fx_earned: fx,
  kept: topups - topupFees - out - outFees + fx,
});

describe('moneyTrail', () => {
  it('scales to top-ups; fees both ways, then withdrawals, come off the right', () => {
    const t = moneyTrail(cash(1000, 20, 400, 4));
    expect(t.max).toBe(1000);
    expect(t.rows.map((r) => r.key)).toEqual([
      'topups',
      'fees',
      'withdrawals',
      'kept',
    ]);
    // Gateway fees = top-up fees 20 + payout fees 4; withdrawals = 400.
    expect(t.rows.map((r) => r.width)).toEqual([100, 2.4, 40, 57.6]);
    expect(t.rows[1].left).toBeCloseTo(97.6);
    expect(t.rows[2].left).toBeCloseTo(57.6);
    expect(t.rows.map((r) => r.amount)).toEqual([1000, -24, -400, 576]);
    expect(t.rows[3].tone).toBe('kept');
  });

  it('a loss scales to money out, stays inside the track and reads as a loss', () => {
    const t = moneyTrail(cash(100, 0, 300, 0));
    expect(t.max).toBe(300);
    for (const r of t.rows) {
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.width).toBeGreaterThanOrEqual(0);
      expect(r.left + r.width).toBeLessThanOrEqual(100.0001);
    }
    expect(t.rows[3]).toMatchObject({ tone: 'loss', amount: -200 });
    expect(t.rows[3].width).toBeCloseTo((200 / 300) * 100);
  });

  it('the FX spread adds a row after withdrawals and is part of cash kept', () => {
    const t = moneyTrail(cash(1000, 20, 400, 4, 12));
    expect(t.rows.map((r) => r.key)).toEqual([
      'topups',
      'fees',
      'withdrawals',
      'fx',
      'kept',
    ]);
    const fx = t.rows[3];
    expect(fx).toMatchObject({ amount: 12, tone: 'in' });
    expect(fx.left).toBeCloseTo(57.6);
    expect(fx.width).toBeCloseTo(1.2);
    expect(t.rows[4].amount).toBe(588);
  });

  it('no spread, no FX row', () => {
    expect(moneyTrail(cash(10, 0, 5, 0)).rows.some((r) => r.key === 'fx')).toBe(
      false,
    );
  });

  it('all zero draws nothing (no NaN widths)', () => {
    const t = moneyTrail(cash(0, 0, 0, 0));
    expect(t.rows.every((r) => r.width === 0 && r.left === 0)).toBe(true);
  });
});
