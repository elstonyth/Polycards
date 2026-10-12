import {
  callbackLedgerAmount,
  regionalDepositBand,
  PAYMENT_FX_MAX_AGE_MS,
  creditForDeposit,
  paymentFxQuote,
  payoutForWithdrawal,
  rowFx,
  toLedgerAmount,
  type PaymentFxQuote,
} from '../payment-fx';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const fresh = new Date(NOW - 60_000);

function quote(row: Parameters<typeof paymentFxQuote>[0]): PaymentFxQuote {
  const q = paymentFxQuote(row, 'SGD', NOW);
  if ('error' in q) throw new Error(q.error);
  return q;
}

describe('paymentFxQuote', () => {
  it('spreads the markup both ways around the mid', () => {
    const q = quote({ rate: 3.3, fetched_at: fresh, markup: 0.01 });
    expect(q).toMatchObject({
      mid: 3.3,
      markup: 0.01,
      depositRate: 3.29,
      payoutRate: 3.31,
      source: 'feed',
    });
  });

  it('reads bigNumber columns that arrive as strings', () => {
    const q = quote({ rate: '3.3', fetched_at: fresh, markup: '0.1' });
    expect(q.depositRate).toBe(3.2);
    expect(q.payoutRate).toBe(3.4);
  });

  it('prefers an admin override and exempts it from the age limit', () => {
    const q = quote({
      rate: 3.3,
      fetched_at: new Date(0),
      manual_override: true,
      manual_rate: 3.25,
      markup: 0.01,
    });
    expect(q).toMatchObject({ mid: 3.25, source: 'manual' });
  });

  it('refuses with no row, no rate, or a stale feed — there is no fallback', () => {
    expect(paymentFxQuote(null, 'SGD', NOW)).toHaveProperty('error');
    expect(
      paymentFxQuote({ rate: 0, fetched_at: fresh }, 'SGD', NOW),
    ).toHaveProperty('error');
    expect(
      paymentFxQuote(
        { rate: 3.3, fetched_at: new Date(NOW - PAYMENT_FX_MAX_AGE_MS - 1) },
        'SGD',
        NOW,
      ),
    ).toHaveProperty('error');
    expect(
      paymentFxQuote({ rate: 3.3, fetched_at: null }, 'SGD', NOW),
    ).toHaveProperty('error');
  });

  it('refuses a negative or absurd markup', () => {
    expect(
      paymentFxQuote(
        { rate: 3.3, fetched_at: fresh, markup: -0.01 },
        'SGD',
        NOW,
      ),
    ).toHaveProperty('error');
    expect(
      paymentFxQuote({ rate: 3.3, fetched_at: fresh, markup: 1 }, 'SGD', NOW),
    ).toHaveProperty('error');
  });
});

describe('conversion rounds in our favour', () => {
  const q = { depositRate: 3.29, payoutRate: 3.31 };

  it('credits S$ x depositRate, floored to the cent', () => {
    expect(creditForDeposit(100, q)).toBe(329);
    expect(creditForDeposit(10.01, q)).toBe(32.93); // 32.9329
    expect(creditForDeposit(0.01, { depositRate: 3.2999 })).toBe(0.03);
  });

  it('pays RM / payoutRate, floored to the cent', () => {
    expect(payoutForWithdrawal(331, q)).toBe(100);
    expect(payoutForWithdrawal(100, q)).toBe(30.21); // 30.2114
  });

  it('never pays out more than a deposit of the same S$ credited (round trip loses the spread)', () => {
    for (const sgd of [1, 9.99, 50, 123.45, 3000]) {
      const rm = creditForDeposit(sgd, q);
      expect(payoutForWithdrawal(rm, q)).toBeLessThan(sgd);
    }
  });
});

describe('toLedgerAmount — converts through the row lock', () => {
  it('maps the locked gateway amount to exactly the locked RM amount', () => {
    const row = rowFx({ amount_requested: '329.00', gateway_amount: '100.00' });
    expect(toLedgerAmount(row, 100)).toBe(329);
  });

  it('scales a different reported amount at the locked rate', () => {
    const row = rowFx({ amount_requested: 329, gateway_amount: 100 });
    expect(toLedgerAmount(row, 100.01)).toBe(329.03); // 329.0329
    expect(toLedgerAmount(row, 50)).toBe(164.5);
  });

  it('is the identity for an RM row', () => {
    expect(toLedgerAmount(rowFx({ amount_requested: 50 }), 50)).toBe(50);
    expect(
      toLedgerAmount(rowFx({ amount: 50, gateway_amount: null }), 51),
    ).toBe(51);
  });

  it('passes NaN through so the money fences refuse it', () => {
    const row = rowFx({ amount: 331, gateway_amount: 100 });
    expect(toLedgerAmount(row, NaN)).toBeNaN();
  });

  it('reads a withdrawal row by its amount column', () => {
    const row = rowFx({ amount: 331, gateway_amount: 100 });
    expect(toLedgerAmount(row, 100)).toBe(331);
  });
});

describe('review fixes (2026-10-06)', () => {
  it('refuses to quote with no markup — the rail stays paused until one is set', () => {
    for (const markup of [0, undefined, '0']) {
      expect(
        paymentFxQuote({ rate: 3.3, fetched_at: fresh, markup }, 'SGD', NOW),
      ).toEqual({ error: 'No SGD markup is set.' });
    }
  });

  it('an SGD row without its lock converts to NaN, never 1:1', () => {
    const unlocked = rowFx({ amount_requested: 319, currency: 'SGD' });
    expect(toLedgerAmount(unlocked, 100)).toBeNaN();
    // An RM row (or one from before the lock) still converts 1:1.
    expect(
      toLedgerAmount(rowFx({ amount_requested: 50, currency: 'MYR' }), 50),
    ).toBe(50);
    expect(toLedgerAmount(rowFx({ amount_requested: 50 }), 50)).toBe(50);
  });

  it('a callback for the locked S$ or a small nudge of it credits exactly the locked RM', () => {
    const row = rowFx({
      amount_requested: 319,
      gateway_amount: 100,
      currency: 'SGD',
    });
    expect(callbackLedgerAmount(row, 100)).toBe(319);
    expect(callbackLedgerAmount(row, 100.01)).toBe(319); // nudge kept by us
    expect(callbackLedgerAmount(row, 100.1)).toBe(319);
    // Outside the window it is the proportional figure — which the callback
    // fence then refuses because it differs from the locked credit.
    expect(callbackLedgerAmount(row, 100.11)).toBe(319.35);
    expect(callbackLedgerAmount(row, 99.99)).toBe(318.96);
    expect(callbackLedgerAmount(row, 1000)).toBe(3190);
  });

  it("narrows today's S$ top-up band to what the RM band admits", () => {
    const rmBand = { depositMin: 30, depositMax: 10000 };
    const sgdBand = { depositMin: 10, depositMax: 3000 };
    // At 3.40, S$3,000 would credit RM 10,200 — over the RM ceiling.
    expect(regionalDepositBand({ depositRate: 3.4 }, sgdBand, rmBand)).toEqual({
      min: 10,
      max: 2941.17,
    });
    // At 2.50, S$10 would credit RM 25 — under the RM floor.
    expect(regionalDepositBand({ depositRate: 2.5 }, sgdBand, rmBand)).toEqual({
      min: 12,
      max: 3000,
    });
    // Every amount inside the band converts inside the RM band.
    const band = regionalDepositBand({ depositRate: 3.4 }, sgdBand, rmBand);
    expect(
      creditForDeposit(band.max, { depositRate: 3.4 }),
    ).toBeLessThanOrEqual(10000);
  });
});
