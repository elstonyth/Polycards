import {
  callbackLedgerAmount,
  nudgedDeposit,
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
  const fee = (deposit: unknown, payout: unknown = deposit) => ({
    fee_enabled: true,
    deposit_fee_percent: deposit,
    payout_fee_percent: payout,
  });

  it("takes each direction's percent of the mid: the operator's 3.19 at 0.5% example", () => {
    const q = quote({ rate: 3.19, fetched_at: fresh, ...fee(0.5) });
    expect(q).toMatchObject({
      mid: 3.19,
      feeEnabled: true,
      depositFeePercent: 0.5,
      payoutFeePercent: 0.5,
      depositRate: 3.17405, // 3.19 x 99.5%
      payoutRate: 3.20595, // 3.19 x 100.5%
      depositMarkup: 0.01595,
      payoutMarkup: 0.01595,
      source: 'feed',
    });
  });

  it('prices the two directions separately', () => {
    const q = quote({ rate: 3.2, fetched_at: fresh, ...fee(1, 2) });
    expect(q.depositRate).toBe(3.168);
    expect(q.payoutRate).toBe(3.264);
  });

  it('reads bigNumber columns that arrive as strings', () => {
    const q = quote({ rate: '3.2', fetched_at: fresh, ...fee('3.125') });
    expect(q.depositRate).toBe(3.1);
    expect(q.payoutRate).toBe(3.3);
  });

  it('switched off, both directions are the bare mid, and the rail stays open', () => {
    const q = quote({
      rate: 3.19,
      fetched_at: fresh,
      ...fee(0.5),
      fee_enabled: false,
    });
    expect(q).toMatchObject({
      feeEnabled: false,
      depositFeePercent: 0,
      payoutFeePercent: 0,
      depositRate: 3.19,
      payoutRate: 3.19,
      depositMarkup: 0,
      payoutMarkup: 0,
    });
  });

  it('prefers an admin override and exempts it from the age limit', () => {
    const q = quote({
      rate: 3.3,
      fetched_at: new Date(0),
      manual_override: true,
      manual_rate: 3.25,
      ...fee(0.5),
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

  it('refuses a negative or absurd fee', () => {
    for (const pct of [-0.01, 20.01, 'x']) {
      expect(
        paymentFxQuote({ rate: 3.3, fetched_at: fresh, ...fee(pct) }, 'SGD', NOW),
      ).toEqual({ error: 'The SGD fee is out of range.' });
    }
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
  it('refuses to quote a rail whose fee was never configured — it stays paused', () => {
    for (const fee_enabled of [null, undefined]) {
      expect(
        paymentFxQuote({ rate: 3.3, fetched_at: fresh, fee_enabled }, 'SGD', NOW),
      ).toEqual({ error: 'No SGD fee is set.' });
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

describe('nudgedDeposit — credit what A3Pay actually asks the customer for', () => {
  // mid 3.1905, markup 0.10: 3.0905 RM per S$1.
  const lock = { gatewayAmount: 50, mid: 3.1905, markup: 0.1 };

  it('S$50 nudged to S$50.01 re-locks at the same rate: RM 154.55, not 154.52', () => {
    expect(nudgedDeposit(lock, 50.01)).toEqual({
      gatewayAmount: 50.01,
      credit: 154.55,
    });
  });

  it('a nudge down is re-locked too (they pay less, they get less)', () => {
    expect(nudgedDeposit(lock, 49.99)).toEqual({
      gatewayAmount: 49.99,
      credit: 154.49,
    });
  });

  it('keeps the lock for no change, a non-number, or more than a nudge', () => {
    expect(nudgedDeposit(lock, 50)).toBeNull();
    expect(nudgedDeposit(lock, Number.NaN)).toBeNull();
    expect(nudgedDeposit(lock, 0)).toBeNull();
    expect(nudgedDeposit(lock, 50.11)).toBeNull();
    expect(nudgedDeposit(lock, 60)).toBeNull();
  });

  it('a re-locked row settles its callback at exactly the new credit', () => {
    const relocked = nudgedDeposit(lock, 50.01)!;
    expect(
      callbackLedgerAmount(
        { ledgerAmount: relocked.credit, gatewayAmount: relocked.gatewayAmount },
        50.01,
      ),
    ).toBe(154.55);
  });
});
