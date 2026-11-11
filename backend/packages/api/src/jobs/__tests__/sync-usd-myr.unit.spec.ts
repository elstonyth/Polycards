jest.mock('../../modules/packs/ops-alert', () => ({
  alertOps: jest.fn().mockResolvedValue(undefined),
}));

import syncUsdMyrJob, { config } from '../sync-usd-myr';
import { config as paymentFxConfig } from '../sync-payment-fx';
import { alertOps } from '../../modules/packs/ops-alert';

// USD->MYR prices every card and every sell-back: hourly, ECB first, Coinbase
// when ECB fails, never a broken feed's number, and staff hear about outages.

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
  return {
    packs,
    c: { resolve: (k: string) => (k === 'logger' ? logger : packs) } as never,
  };
}

const alertTags = () =>
  (alertOps as jest.Mock).mock.calls.map((call) => call[1]);

beforeEach(() => (alertOps as jest.Mock).mockClear());

describe('sync-usd-myr', () => {
  it('runs hourly, on its own minute', () => {
    expect(config.schedule).toBe('10 * * * *');
    expect(config.schedule).not.toBe(paymentFxConfig.schedule);
  });

  it("stores ECB's rate, aged from ECB's own date", async () => {
    feeds({ 'api.frankfurter.app': ECB(4.21) });
    const { c, packs } = container(4.2);
    await syncUsdMyrJob(c);
    expect(packs.updateFxRates).toHaveBeenCalledWith([
      {
        id: 'fx_usd',
        rate: 4.21,
        source: 'frankfurter',
        fetched_at: new Date(`${YESTERDAY}T00:00:00Z`),
      },
    ]);
    expect(alertOps).not.toHaveBeenCalled();
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

  it('keeps the last rate and alerts staff when every feed fails', async () => {
    feeds({});
    const { c, packs } = container(4.2);
    await syncUsdMyrJob(c);
    expect(packs.updateFxRates).not.toHaveBeenCalled();
    expect(alertTags()).toEqual(['fx-usd-myr:feed-down']);
  });

  it('refuses a jump past 5% and alerts', async () => {
    feeds({ 'api.frankfurter.app': ECB(4.5) });
    const { c, packs } = container(4.2);
    await syncUsdMyrJob(c);
    expect(packs.updateFxRates).not.toHaveBeenCalled();
    expect(alertTags()).toEqual(['fx-usd-myr:jump']);
  });

  it('alerts when a pin has drifted off the market, and still records the feed', async () => {
    feeds({ 'api.frankfurter.app': ECB(4.3) });
    const { c, packs } = container(4.2, 4.2);
    await syncUsdMyrJob(c);
    expect(alertTags()).toEqual(['fx-usd-myr:pin-drift']);
    expect(packs.updateFxRates.mock.calls[0][0][0].rate).toBe(4.3);
  });

  it('stays quiet for a pin within 1% of the market', async () => {
    feeds({ 'api.frankfurter.app': ECB(4.22) });
    const { c } = container(4.2, 4.2);
    await syncUsdMyrJob(c);
    expect(alertOps).not.toHaveBeenCalled();
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
});
