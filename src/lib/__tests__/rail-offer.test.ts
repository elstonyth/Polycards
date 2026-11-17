import { describe, expect, it } from 'vitest';
import { DEPOSIT_METHODS } from '@/lib/deposit-methods';
import type { PaymentLimits, RegionalRail } from '@/lib/payment-limits';
import { REGIONAL_RAILS } from '@/lib/regional-rails';
import {
  DEPOSIT_BAND_FALLBACK,
  depositOffer,
  payoutOffer,
} from '@/lib/rail-offer';

// The answer both money forms render: which rails, what band, is it open.
// Every S$ fix (#755 #757 #764 #765 #779) used to land inside the components;
// these pin the same answers without React.

const SGD: RegionalRail = {
  gateway: 'a3pay',
  currency: 'SGD',
  depositsEnabled: true,
  withdrawalsEnabled: true,
  deposit: { min: 30, max: 5000 },
  withdrawal: { min: 30, max: 3000 },
  withdrawalRm: { minRm: 96.05, maxRm: 9605.1 },
  rate: { deposit: 3.0812, payout: 3.2017 },
};

const limits = (over: Partial<PaymentLimits> = {}): PaymentLimits => ({
  gateway: 'tgpay',
  deposit: { minRm: 50, maxRm: 10000 },
  withdrawal: { minRm: 50, maxRm: 30000 },
  depositsEnabled: true,
  withdrawalsEnabled: true,
  regional: [SGD],
  ...over,
});

const PAUSED_HINT = 'Paused right now — your balance and cards are unaffected';
const gateway = { gateway: true };
const mock = { gateway: false };

describe('depositOffer: band and closed', () => {
  it.each([
    {
      name: 'gateway, RM: the active gateway band',
      limits: limits(),
      currency: 'MYR',
      opts: gateway,
      band: { min: 50, max: 10000 },
      closed: false,
    },
    {
      name: 'gateway, RM, a zero floor: still one cent',
      limits: limits({ deposit: { minRm: 0, maxRm: 8000 } }),
      currency: 'MYR',
      opts: gateway,
      band: { min: 0.01, max: 8000 },
      closed: false,
    },
    {
      name: 'gateway, RM paused: closed',
      limits: limits({ depositsEnabled: false }),
      currency: 'MYR',
      opts: gateway,
      band: { min: 50, max: 10000 },
      closed: true,
    },
    {
      name: 'gateway, S$ open while RM paused: the rail band, open',
      limits: limits({ depositsEnabled: false }),
      currency: 'SGD',
      opts: gateway,
      band: { min: 30, max: 5000 },
      closed: false,
    },
    {
      name: 'gateway, S$ rail with no edges: the fallback band',
      limits: limits({
        regional: [{ ...SGD, deposit: { min: null, max: null } }],
      }),
      currency: 'SGD',
      opts: gateway,
      band: DEPOSIT_BAND_FALLBACK,
      closed: false,
    },
    {
      name: 'gateway, S$ rail closed: back on the RM band',
      limits: limits({ regional: [{ ...SGD, depositsEnabled: false }] }),
      currency: 'SGD',
      opts: gateway,
      band: { min: 50, max: 10000 },
      closed: false,
    },
    {
      name: 'mock: the fallback band, even with an open S$ rail',
      limits: limits(),
      currency: 'MYR',
      opts: mock,
      band: DEPOSIT_BAND_FALLBACK,
      closed: false,
    },
    {
      name: 'mock, deposits disabled: never closed',
      limits: limits({ depositsEnabled: false }),
      currency: 'MYR',
      opts: mock,
      band: DEPOSIT_BAND_FALLBACK,
      closed: false,
    },
  ])('$name', ({ limits: l, currency, opts, band, closed }) => {
    const offer = depositOffer(l, DEPOSIT_METHODS, currency, opts);
    expect(offer.band).toEqual(band);
    expect(offer.closed).toBe(closed);
  });

  it('one cent is the fallback floor and RM 10,000 its ceiling', () => {
    expect(DEPOSIT_BAND_FALLBACK).toEqual({ min: 0.01, max: 10_000 });
  });
});

describe('depositOffer: inBand', () => {
  it.each([
    { name: 'RM below the gateway floor', currency: 'MYR', amount: 49.99, ok: false },
    { name: 'RM on the floor', currency: 'MYR', amount: 50, ok: true },
    { name: 'RM on the ceiling', currency: 'MYR', amount: 10000, ok: true },
    { name: 'RM above the ceiling', currency: 'MYR', amount: 10000.01, ok: false },
    { name: 'S$ below the rail floor', currency: 'SGD', amount: 29.99, ok: false },
    { name: 'S$ under the RM floor but inside its own', currency: 'SGD', amount: 30, ok: true },
    { name: 'S$ above the rail ceiling', currency: 'SGD', amount: 5000.01, ok: false },
  ])('$name', ({ currency, amount, ok }) => {
    expect(
      depositOffer(limits(), DEPOSIT_METHODS, currency, gateway).inBand(amount),
    ).toBe(ok);
  });

  it('mock: one cent passes, above 10,000 does not', () => {
    const offer = depositOffer(limits(), DEPOSIT_METHODS, 'MYR', mock);
    expect(offer.inBand(0.01)).toBe(true);
    expect(offer.inBand(0)).toBe(false);
    expect(offer.inBand(10_000.01)).toBe(false);
  });
});

describe('depositOffer: rail, channels and credit', () => {
  it('RM: no rail, the RM channels as given, credit is the amount', () => {
    const offer = depositOffer(limits(), DEPOSIT_METHODS, 'MYR', gateway);
    expect(offer.rail).toBeUndefined();
    expect(offer.methods).toBe(DEPOSIT_METHODS);
    expect(offer.credit(123.45)).toBe(123.45);
  });

  it('S$: the rail, its own channels, credit at the quoted rate', () => {
    const offer = depositOffer(limits(), DEPOSIT_METHODS, 'SGD', gateway);
    expect(offer.rail?.currency).toBe('SGD');
    expect(offer.methods).toBe(REGIONAL_RAILS.SGD!.methods);
    // 100 × 3.0812, floored to the cent as the backend quotes it.
    expect(offer.credit(100)).toBe(308.12);
  });

  it('nothing chosen yet: no rail', () => {
    expect(
      depositOffer(limits(), DEPOSIT_METHODS, null, gateway).rail,
    ).toBeUndefined();
  });

  it('mock: no rail even when the currency names an open one', () => {
    expect(
      depositOffer(limits(), DEPOSIT_METHODS, 'SGD', mock).rail,
    ).toBeUndefined();
  });
});

describe('depositOffer: the currency rows', () => {
  const codes = (l: PaymentLimits, opts = gateway) =>
    depositOffer(l, DEPOSIT_METHODS, null, opts).options.map((o) => [
      o.code,
      o.disabled === true,
    ]);

  it('RM first, then each open rail with its rate', () => {
    const { options } = depositOffer(limits(), DEPOSIT_METHODS, null, gateway);
    expect(options).toEqual([
      {
        code: 'MYR',
        symbol: 'RM',
        flag: 'MY',
        name: 'Malaysian Ringgit',
        hint: 'Online banking (FPX) · QR / e-wallet',
        disabled: false,
      },
      {
        code: 'SGD',
        symbol: 'S$',
        flag: 'SG',
        name: 'Singapore Dollar',
        hint: 'PayNow QR · bank transfer · S$1 = RM 3.0812',
      },
    ]);
  });

  it('RM paused: listed, disabled, with the paused hint', () => {
    const rm = depositOffer(
      limits({ depositsEnabled: false }),
      DEPOSIT_METHODS,
      null,
      gateway,
    ).options[0];
    expect(rm).toMatchObject({ code: 'MYR', disabled: true, hint: PAUSED_HINT });
  });

  it('a closed or unpriced rail is a paused row after the open ones', () => {
    const usdt: RegionalRail = {
      ...SGD,
      gateway: 'gp365',
      currency: 'USDT',
      depositsEnabled: false,
    };
    expect(codes(limits({ regional: [usdt, SGD] }))).toEqual([
      ['MYR', false],
      ['SGD', false],
      ['USDT', true],
    ]);
    expect(codes(limits({ regional: [{ ...SGD, rate: null }] }))).toEqual([
      ['MYR', false],
      ['SGD', true],
    ]);
    const paused = depositOffer(
      limits({ regional: [{ ...SGD, depositsEnabled: false }] }),
      DEPOSIT_METHODS,
      null,
      gateway,
    ).options[1];
    expect(paused).toMatchObject({ code: 'SGD', hint: PAUSED_HINT });
  });

  it('a currency this build has no rail for gets no row', () => {
    expect(
      codes(limits({ regional: [{ ...SGD, currency: 'THB' }] })),
    ).toEqual([['MYR', false]]);
  });

  it('mock: RM only, never paused', () => {
    expect(codes(limits({ depositsEnabled: false }), mock)).toEqual([
      ['MYR', false],
    ]);
  });
});

describe('payoutOffer: rail, band and closed', () => {
  it.each([
    {
      name: 'RM account: the gateway band, open',
      limits: limits(),
      to: { currency: 'MYR' },
      rail: undefined,
      band: { minRm: 50, maxRm: 30000 },
      closed: false,
    },
    {
      name: 'RM account from an older backend (no currency): RM',
      limits: limits(),
      to: {},
      rail: undefined,
      band: { minRm: 50, maxRm: 30000 },
      closed: false,
    },
    {
      name: 'RM account, withdrawals disabled: closed',
      limits: limits({ withdrawalsEnabled: false }),
      to: { currency: 'MYR' },
      rail: undefined,
      band: { minRm: 50, maxRm: 30000 },
      closed: true,
    },
    {
      name: 'S$ account: the rail RM band, open even with RM disabled',
      limits: limits({ withdrawalsEnabled: false }),
      to: { currency: 'SGD' },
      rail: 'SGD',
      band: { minRm: 96.05, maxRm: 9605.1 },
      closed: false,
    },
    {
      name: 'S$ account, older backend without withdrawalRm: the RM band',
      limits: limits({ regional: [{ ...SGD, withdrawalRm: undefined }] }),
      to: { currency: 'SGD' },
      rail: 'SGD',
      band: { minRm: 50, maxRm: 30000 },
      closed: false,
    },
    {
      name: 'S$ account, rail paused: closed',
      limits: limits({ regional: [{ ...SGD, withdrawalsEnabled: false }] }),
      to: { currency: 'SGD' },
      rail: undefined,
      band: { minRm: 50, maxRm: 30000 },
      closed: true,
    },
    {
      name: 'account in a currency with no rail here: closed',
      limits: limits(),
      to: { currency: 'THB' },
      rail: undefined,
      band: { minRm: 50, maxRm: 30000 },
      closed: true,
    },
    {
      name: 'no account, RM disabled, a rail open: open',
      limits: limits({ withdrawalsEnabled: false }),
      to: undefined,
      rail: undefined,
      band: { minRm: 50, maxRm: 30000 },
      closed: false,
    },
    {
      name: 'no account, RM disabled, no rail open: closed',
      limits: limits({ withdrawalsEnabled: false, regional: [] }),
      to: undefined,
      rail: undefined,
      band: { minRm: 50, maxRm: 30000 },
      closed: true,
    },
  ])('$name', ({ limits: l, to, rail, band, closed }) => {
    const offer = payoutOffer(l, to);
    expect(offer.rail?.currency).toBe(rail);
    expect(offer.band).toEqual(band);
    expect(offer.closed).toBe(closed);
    expect(offer.accountMin).toBeNull();
  });
});

describe('payoutOffer: an account floor above the band', () => {
  it.each([
    { name: 'above the floor: it binds', floor: 100, accountMin: 100, min: 100 },
    { name: 'equal to the floor: none', floor: 50, accountMin: null, min: 50 },
    { name: 'below the floor: none', floor: 10, accountMin: null, min: 50 },
    { name: 'null: none', floor: null, accountMin: null, min: 50 },
  ])('$name', ({ floor, accountMin, min }) => {
    const offer = payoutOffer(limits(), { currency: 'MYR' }, floor);
    expect(offer.accountMin).toBe(accountMin);
    expect(offer.band).toEqual({ minRm: min, maxRm: 30000 });
  });

  it('judged against the rail band for an S$ account', () => {
    expect(payoutOffer(limits(), { currency: 'SGD' }, 90).accountMin).toBe(
      null,
    );
    expect(payoutOffer(limits(), { currency: 'SGD' }, 120).accountMin).toBe(
      120,
    );
  });
});

describe('payoutOffer: payout and outOfBand', () => {
  it('RM: nothing converted', () => {
    const offer = payoutOffer(limits(), { currency: 'MYR' });
    expect(offer.payout(500)).toBeNull();
    expect(offer.outOfBand(500)).toBeNull();
  });

  it.each([
    { name: 'below the RM floor', amount: 49.99, out: 'rm' },
    { name: 'above the RM ceiling', amount: 30000.01, out: 'rm' },
    { name: 'on the floor', amount: 50, out: null },
    { name: 'on the ceiling', amount: 30000, out: null },
  ])('RM $name', ({ amount, out }) => {
    expect(payoutOffer(limits(), { currency: 'MYR' }).outOfBand(amount)).toBe(
      out,
    );
  });

  it('below an account floor is out of the RM band', () => {
    expect(
      payoutOffer(limits(), { currency: 'MYR' }, 100).outOfBand(99),
    ).toBe('rm');
  });

  it('S$: converts at the payout rate, floored to the cent', () => {
    // 500 / 3.2017 = 156.167…
    expect(payoutOffer(limits(), { currency: 'SGD' }).payout(500)).toBe(156.16);
  });

  it.each([
    { name: 'below the rail RM floor: the RM check first', amount: 90, out: 'rm' },
    { name: 'inside both bands', amount: 500, out: null },
  ])('S$ $name', ({ amount, out }) => {
    expect(payoutOffer(limits(), { currency: 'SGD' }).outOfBand(amount)).toBe(
      out,
    );
  });

  it('S$: inside the RM band but converting under the S$ floor', () => {
    // An older backend with no withdrawalRm: RM 60 passes RM 50–30,000 but
    // pays S$18.74, under the rail's S$30.
    const offer = payoutOffer(
      limits({ regional: [{ ...SGD, withdrawalRm: undefined }] }),
      { currency: 'SGD' },
    );
    expect(offer.outOfBand(60)).toBe('regional');
    expect(offer.outOfBand(20000)).toBe('regional');
    expect(offer.outOfBand(500)).toBeNull();
  });

  it('S$: a rail edge it does not set is not checked', () => {
    const offer = payoutOffer(
      limits({
        regional: [
          {
            ...SGD,
            withdrawalRm: undefined,
            withdrawal: { min: null, max: null },
          },
        ],
      }),
      { currency: 'SGD' },
    );
    expect(offer.outOfBand(60)).toBeNull();
    expect(offer.outOfBand(20000)).toBeNull();
  });
});
