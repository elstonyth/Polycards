import syncUsdMyrJob, { config, FX_DAY_UPSERT_SQL } from '../sync-usd-myr';
import { config as paymentFxConfig } from '../sync-payment-fx';

// USD->MYR prices every card and every sell-back: hourly, ECB first, Coinbase
// when ECB fails, never a broken feed's number, and every problem is in the
// log (no Telegram alert, owner 2026-11-11).

// Dated yesterday, so the test never ages past the staleness guard.
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const ECB = (myr: unknown, base = 'USD', date = YESTERDAY) =>
  JSON.stringify({ amount: 1, base, date, rates: { MYR: myr } });
const COINBASE = (myr: string) =>
  JSON.stringify({ data: { currency: 'USD', rates: { MYR: myr } } });

function feeds(answers: Record<string, string | Error>) {
  global.fetch = jest.fn(async (url: string) => {
    const answer = answers[new URL(url).hostname];
    if (!answer || answer instanceof Error) throw answer ?? new Error('down');
    return { ok: true, status: 200, json: async () => JSON.parse(answer) };
  }) as unknown as typeof fetch;
}

function container(stored: number | null, pinned: number | null = null) {
  const packs = {
    listFxRates: jest.fn().mockResolvedValue(
      stored === null
        ? []
        : [
            {
              id: 'fx_usd',
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
  const pg = { raw: jest.fn().mockResolvedValue(undefined) };
  return {
    packs,
    logger,
    pg,
    c: {
      resolve: (k: string) =>
        k === 'logger' ? logger : k === '__pg_connection__' ? pg : packs,
    } as never,
  };
}

// The log lines that flag a problem (warn for a failed feed, error for a
// refused jump or a drifted pin), by marker.
const flagged = (logger: { warn: jest.Mock; error: jest.Mock }) =>
  [...logger.warn.mock.calls, ...logger.error.mock.calls]
    .map(([m]) => String(m))
    .filter((m) => /every feed failed|NOT applied|is pinned at/.test(m));

describe('sync-usd-myr', () => {
  it('runs hourly, on its own minute', () => {
    expect(config.schedule).toBe('10 * * * *');
    expect(config.schedule).not.toBe(paymentFxConfig.schedule);
  });

  it("stores ECB's rate, aged from ECB's own date", async () => {
    feeds({ 'api.frankfurter.app': ECB(4.21) });
    const { c, packs, logger } = container(4.2);
    await syncUsdMyrJob(c);
    expect(packs.updateFxRates).toHaveBeenCalledWith([
      {
        id: 'fx_usd',
        rate: 4.21,
        source: 'frankfurter',
        fetched_at: new Date(`${YESTERDAY}T00:00:00Z`),
      },
    ]);
    expect(flagged(logger)).toEqual([]);
  });

  it('falls back to Coinbase when ECB is down', async () => {
    feeds({ 'api.coinbase.com': COINBASE('4.2033') });
    const { c, packs } = container(4.2);
    await syncUsdMyrJob(c);
    expect(packs.updateFxRates.mock.calls[0][0][0]).toMatchObject({
      rate: 4.2033,
      source: 'coinbase',
    });
  });

  it.each([
    ['out of band', ECB(42.1)],
    ['for the wrong currency', ECB(4.21, 'SGD')],
    ['not a number', ECB(true)],
    ['dated over a week ago', ECB(4.21, 'USD', '2020-01-02')],
  ])('refuses an ECB answer %s and uses Coinbase', async (_why, body) => {
    feeds({ 'api.frankfurter.app': body, 'api.coinbase.com': COINBASE('4.2') });
    const { c, packs } = container(4.2);
    await syncUsdMyrJob(c);
    expect(packs.updateFxRates.mock.calls[0][0][0].source).toBe('coinbase');
  });

  it('keeps the last rate and logs it when every feed fails, with no Telegram call', async () => {
    feeds({});
    const { c, packs, logger } = container(4.2);
    await syncUsdMyrJob(c);
    expect(packs.updateFxRates).not.toHaveBeenCalled();
    expect(flagged(logger)).toEqual([
      expect.stringContaining('every feed failed'),
    ]);
    const hosts = (global.fetch as jest.Mock).mock.calls.map(
      ([url]) => new URL(url).hostname,
    );
    expect(hosts).not.toContain('api.telegram.org');
  });

  it('refuses a jump past 5% and logs it', async () => {
    feeds({ 'api.frankfurter.app': ECB(4.5) });
    const { c, packs, logger } = container(4.2);
    await syncUsdMyrJob(c);
    expect(packs.updateFxRates).not.toHaveBeenCalled();
    expect(flagged(logger)).toEqual([expect.stringContaining('NOT applied')]);
  });

  it('logs a pin that has drifted off the market, and still records the feed', async () => {
    feeds({ 'api.frankfurter.app': ECB(4.3) });
    const { c, packs, logger } = container(4.2, 4.2);
    await syncUsdMyrJob(c);
    expect(flagged(logger)).toEqual([expect.stringContaining('is pinned at')]);
    expect(packs.updateFxRates.mock.calls[0][0][0].rate).toBe(4.3);
  });

  it('stays quiet for a pin within 1% of the market', async () => {
    feeds({ 'api.frankfurter.app': ECB(4.22) });
    const { c, logger } = container(4.2, 4.2);
    await syncUsdMyrJob(c);
    expect(flagged(logger)).toEqual([]);
  });

  it('creates the row on an empty table', async () => {
    feeds({ 'api.frankfurter.app': ECB(4.21) });
    const { c, packs } = container(null);
    await syncUsdMyrJob(c);
    expect(packs.createFxRates.mock.calls[0][0][0]).toMatchObject({
      pair: 'USD_MYR',
      rate: 4.21,
    });
  });

  // fx_rate_day: one effective rate per MYT day for the P&L report.
  describe('daily rate history', () => {
    const TODAY = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur',
    });

    it("saves today's rate after a sync", async () => {
      feeds({ 'api.frankfurter.app': ECB(4.21) });
      const { c, pg } = container(4.2);
      await syncUsdMyrJob(c);
      // The stored row (mocked, not re-read) is what prices today.
      expect(pg.raw).toHaveBeenCalledWith(FX_DAY_UPSERT_SQL, [
        'USD_MYR',
        TODAY,
        4.2,
      ]);
    });

    it('saves the pin, not the feed, while a pin is set', async () => {
      feeds({ 'api.frankfurter.app': ECB(4.21) });
      const { c, pg } = container(4.2, 4.3);
      await syncUsdMyrJob(c);
      expect(pg.raw).toHaveBeenCalledWith(FX_DAY_UPSERT_SQL, [
        'USD_MYR',
        TODAY,
        4.3,
      ]);
    });

    it('still saves the last good rate when every feed fails', async () => {
      feeds({});
      const { c, pg } = container(4.2);
      await syncUsdMyrJob(c);
      expect(pg.raw).toHaveBeenCalledWith(FX_DAY_UPSERT_SQL, [
        'USD_MYR',
        TODAY,
        4.2,
      ]);
    });

    it('never saves the display fallback', async () => {
      feeds({});
      const { c, pg } = container(null);
      await syncUsdMyrJob(c);
      expect(pg.raw).not.toHaveBeenCalled();
    });

    it('a failed save is logged, never thrown', async () => {
      feeds({ 'api.frankfurter.app': ECB(4.21) });
      const { c, pg, logger } = container(4.2);
      pg.raw.mockRejectedValue(new Error('relation does not exist'));
      await expect(syncUsdMyrJob(c)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not saved to fx_rate_day'),
      );
    });
  });
});
