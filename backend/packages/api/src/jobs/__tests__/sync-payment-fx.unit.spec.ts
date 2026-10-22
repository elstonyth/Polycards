jest.mock('../../modules/packs/ops-alert', () => ({
  alertOps: jest.fn().mockResolvedValue(undefined),
}));

import syncPaymentFxJob, { config, fetchPaymentFx } from '../sync-payment-fx';
import { alertOps } from '../../modules/packs/ops-alert';

// The SGD->MYR mid behind every S$ top-up and payout: hourly from Coinbase,
// ECB (frankfurter) when Coinbase fails, and never a jump a broken feed
// could have produced.

const COINBASE = (myr: string, currency = 'SGD') =>
  JSON.stringify({ data: { currency, rates: { MYR: myr, USD: '0.78' } } });
const FRANKFURTER = (myr: number) =>
  JSON.stringify({
    amount: 1,
    base: 'SGD',
    date: '2026-10-12',
    rates: { MYR: myr },
  });

function feeds(
  answers: Record<string, { status: number; body: string } | Error>,
) {
  global.fetch = jest.fn(async (url: string) => {
    const host = new URL(url).hostname;
    const answer = answers[host];
    if (!answer || answer instanceof Error) throw answer ?? new Error('down');
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => JSON.parse(answer.body),
    };
  }) as unknown as typeof fetch;
}

function container(stored: number | null, pinned: number | null = null) {
  const packs = {
    listFxRates: jest.fn().mockResolvedValue(
      stored === null
        ? []
        : [
            {
              id: 'fx_1',
              rate: stored,
              manual_override: pinned !== null,
              manual_rate: pinned,
            },
          ],
    ),
    updateFxRates: jest.fn().mockResolvedValue(undefined),
    createFxRates: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    packs,
    logger,
    c: { resolve: (k: string) => (k === 'logger' ? logger : packs) } as never,
  };
}

beforeEach(() => (alertOps as jest.Mock).mockClear());

describe('sync-payment-fx', () => {
  it('runs hourly', () => {
    expect(config.schedule).toBe('5 * * * *');
  });

  it("stores Coinbase's live rate, rounded to 6 places, stamped now", async () => {
    feeds({
      'api.coinbase.com': {
        status: 200,
        body: COINBASE('3.18862800544207525038'),
      },
    });
    const { c, packs } = container(3.1905);
    const before = Date.now();
    await syncPaymentFxJob(c);
    const [[write]] = packs.updateFxRates.mock.calls[0];
    expect(write).toMatchObject({
      id: 'fx_1',
      rate: 3.188628,
      source: 'coinbase',
    });
    expect(write.fetched_at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('falls back to ECB (dated by its publication day) when Coinbase is down', async () => {
    feeds({
      'api.coinbase.com': new Error('ECONNRESET'),
      'api.frankfurter.dev': { status: 200, body: FRANKFURTER(3.1901) },
    });
    const { c, packs } = container(3.1905);
    await syncPaymentFxJob(c);
    const [[write]] = packs.updateFxRates.mock.calls[0];
    expect(write).toMatchObject({ rate: 3.1901, source: 'frankfurter' });
    expect(write.fetched_at.toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });

  it('falls back on an answer outside the band or for another currency', async () => {
    for (const body of [COINBASE('31.9'), COINBASE('0.78', 'USD')]) {
      feeds({
        'api.coinbase.com': { status: 200, body },
        'api.frankfurter.dev': { status: 200, body: FRANKFURTER(3.1901) },
      });
      const { c, packs } = container(3.1905);
      await syncPaymentFxJob(c);
      expect(packs.updateFxRates.mock.calls[0][0][0].source).toBe(
        'frankfurter',
      );
    }
  });

  it('refuses a feed that does not say it quotes SGD, or a rate that is not a number', async () => {
    const bodies = [
      // No currency label at all.
      JSON.stringify({ data: { rates: { MYR: '3.18' } } }),
      // Number(true) is 1, inside the 1–10 band.
      JSON.stringify({ data: { currency: 'SGD', rates: { MYR: true } } }),
    ];
    for (const body of bodies) {
      feeds({
        'api.coinbase.com': { status: 200, body },
        'api.frankfurter.dev': {
          status: 200,
          body: JSON.stringify({
            base: 'USD',
            date: '2026-10-12',
            rates: { MYR: 4.2 },
          }),
        },
      });
      const { c, packs } = container(3.1905);
      await syncPaymentFxJob(c);
      expect(packs.updateFxRates).not.toHaveBeenCalled();
    }
  });

  it('measures a jump against a pinned manual rate, so pinning lets a real move back in', async () => {
    feeds({ 'api.coinbase.com': { status: 200, body: COINBASE('3.40') } });
    // Stored feed 3.1905 (6.6% away) but the admin pinned 3.39 (0.3% away).
    const { c, packs } = container(3.1905, 3.39);
    await syncPaymentFxJob(c);
    expect(packs.updateFxRates.mock.calls[0][0][0]).toMatchObject({
      rate: 3.4,
      source: 'coinbase',
    });
    // The job prices USDT too, and this mock serves only SGD: no SGD alert.
    expect(
      jest
        .mocked(alertOps)
        .mock.calls.filter(([, key]) => String(key).includes('SGD')),
    ).toEqual([]);
  });

  it('prices USDT from Coinbase USDT, falling back to USD by proxy only', async () => {
    const usdt = {
      url: 'https://api.coinbase.com/v2/exchange-rates?currency=USDT',
      min: 2,
      max: 8,
    };
    feeds({
      'api.coinbase.com': {
        status: 200,
        body: JSON.stringify({
          data: { currency: 'USDT', rates: { MYR: '4.0793' } },
        }),
      },
    });
    await expect(fetchPaymentFx('USDT', usdt)).resolves.toMatchObject({
      rate: 4.0793,
      source: 'coinbase',
    });
    feeds({
      'api.frankfurter.dev': {
        status: 200,
        body: JSON.stringify({ base: 'USD', date: '2026-10-12', rates: { MYR: 4.2 } }),
      },
    });
    const ecb = {
      url: 'https://api.frankfurter.dev/v1/latest?from=USD&to=MYR',
      min: 2,
      max: 8,
    };
    // Named as the proxy it is, the USD answer prices USDT...
    await expect(
      fetchPaymentFx('USDT', { ...ecb, quotes: 'USD' }),
    ).resolves.toMatchObject({ rate: 4.2 });
    // ...and without that, a USD answer for USDT is a wrong pair.
    await expect(fetchPaymentFx('USDT', ecb)).rejects.toThrow(/answered for USD/);
  });

  it('keeps the last rate when every feed fails', async () => {
    feeds({
      'api.coinbase.com': { status: 503, body: '{}' },
      'api.frankfurter.dev': new Error('down'),
    });
    const { c, packs, logger } = container(3.1905);
    await syncPaymentFxJob(c);
    expect(packs.updateFxRates).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('every feed failed'),
    );
    // Not just a log line: the rate now ages toward its limit unseen.
    expect(alertOps).toHaveBeenCalledWith(
      c,
      'fx-feed-down:SGD',
      expect.stringContaining('every feed failed'),
      { muteMs: 6 * 60 * 60 * 1000 },
    );
  });

  it('alerts when a pinned rate has drifted from the market by more than the fee', async () => {
    // Pinned 3.30, market 3.40: payouts at 3.30 x 1.005 cost less RM per S$
    // than the market, so every payout loses money while the pin stays.
    feeds({ 'api.coinbase.com': { status: 200, body: COINBASE('3.40') } });
    const { c } = container(3.1905, 3.3);
    await syncPaymentFxJob(c);
    expect(alertOps).toHaveBeenCalledWith(
      c,
      'fx-pin-drift:SGD',
      expect.stringContaining('pinned'),
      { muteMs: 6 * 60 * 60 * 1000 },
    );
  });

  it('refuses a feed dated in the future, and never ages a rate from tomorrow', async () => {
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const dated = (date: string) => ({
      status: 200,
      body: JSON.stringify({ base: 'SGD', date, rates: { MYR: 3.19 } }),
    });
    const url = 'https://api.frankfurter.dev/v1/latest?from=SGD&to=MYR';
    feeds({ 'api.frankfurter.dev': dated(day(3)) });
    await expect(
      fetchPaymentFx('SGD', { url, min: 1, max: 10 }),
    ).rejects.toThrow(/future/);
    feeds({ 'api.frankfurter.dev': dated(day(1)) });
    const { asOf } = await fetchPaymentFx('SGD', { url, min: 1, max: 10 });
    expect(asOf.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('refuses a jump of more than 5% in one run, and alerts ops', async () => {
    feeds({ 'api.coinbase.com': { status: 200, body: COINBASE('3.40') } });
    const { c, packs } = container(3.1905);
    await syncPaymentFxJob(c);
    expect(packs.updateFxRates).not.toHaveBeenCalled();
    expect(alertOps).toHaveBeenCalledWith(
      c,
      'fx-jump:SGD',
      expect.stringContaining('NOT applied'),
      { muteMs: 6 * 60 * 60 * 1000 },
    );
  });

  it('creates the row the first time, with no jump to measure', async () => {
    feeds({ 'api.coinbase.com': { status: 200, body: COINBASE('3.1886') } });
    const { c, packs } = container(null);
    await syncPaymentFxJob(c);
    expect(packs.createFxRates).toHaveBeenCalledWith([
      expect.objectContaining({
        pair: 'SGD_MYR',
        rate: 3.1886,
        source: 'coinbase',
      }),
    ]);
  });

  it('fetchPaymentFx refuses a non-2xx answer', async () => {
    feeds({ 'api.coinbase.com': { status: 429, body: '{}' } });
    await expect(
      fetchPaymentFx('SGD', {
        url: 'https://api.coinbase.com/v2/exchange-rates?currency=SGD',
        min: 1,
        max: 10,
      }),
    ).rejects.toThrow(/HTTP 429/);
  });
});
