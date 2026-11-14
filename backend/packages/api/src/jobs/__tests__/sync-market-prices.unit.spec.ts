import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../modules/packs';
import { pcFetch } from '../../api/admin/pricecharting/client';
import syncMarketPricesJob, { runMarketPriceSync } from '../sync-market-prices';

jest.mock('../../api/admin/pricecharting/client', () => ({
  pcFetch: jest.fn(),
}));

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

it('persists a safe error and clears pending after an unexpected failure, then continues', async () => {
  jest.useFakeTimers();
  const cards = ['failed', 'healthy'].map((handle) => ({
    id: handle,
    handle,
    pc_product_id: '6910',
    pc_grade: 'PSA 10',
    market_value: 100,
  }));
  const packs = {
    listCards: jest.fn(async (filter: { id?: string }) =>
      filter.id ? cards.filter((card) => card.id === filter.id) : cards,
    ),
    listFxRates: jest.fn(async () => [{ id: 'fx' }]),
    updateFxRates: jest.fn(),
    applyCardPriceSync: jest.fn().mockResolvedValue(true),
    listSiteSettings: jest.fn(async () => []),
    listCardPriceHistories: jest.fn(async () => [{ value: 100 }]),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const quote = { status: 'success', id: '6910', 'manual-only-price': 10000 };
  jest
    .mocked(pcFetch)
    .mockRejectedValueOnce(new Error('internal URL with secret'))
    .mockResolvedValueOnce({ kind: 'ok', data: quote });
  const running = runMarketPriceSync({
    resolve: (key: string) => (key === PACKS_MODULE ? packs : logger),
  } as unknown as MedusaContainer);
  await jest.runAllTimersAsync();
  await running;
  expect(packs.applyCardPriceSync.mock.calls[0][1]).toEqual({
    id: 'failed',
    pc_pending_price: null,
    pc_sync_error: 'Price sync failed; retry on the next scheduled sync.',
  });
  expect(packs.applyCardPriceSync.mock.calls[1][1]).toEqual(
    expect.objectContaining({
      id: 'healthy',
      market_value: 100,
      pc_sync_error: null,
    }),
  );
});

it('reads the current card before fetching so edits made during the catalog sweep are respected', async () => {
  jest.useFakeTimers();
  const original = {
    id: 'card',
    handle: 'card',
    pc_product_id: '6910',
    pc_grade: 'PSA 10',
    market_value: 875,
  };
  const current = { ...original, pc_product_id: '9999', market_value: 50 };
  const packs = {
    listCards: jest.fn(async (filter: { id?: string }) => [
      filter.id ? current : original,
    ]),
    listFxRates: jest.fn(async () => [{ id: 'fx' }]),
    updateFxRates: jest.fn(),
    applyCardPriceSync: jest.fn().mockResolvedValue(true),
    listSiteSettings: jest.fn(async () => []),
    listCardPriceHistories: jest.fn(async () => [{ value: 47.5 }]),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const quote = { status: 'success', id: '9999', 'manual-only-price': 4750 };
  jest.mocked(pcFetch).mockResolvedValueOnce({ kind: 'ok', data: quote });
  const running = runMarketPriceSync({
    resolve: (key: string) => (key === PACKS_MODULE ? packs : logger),
  } as unknown as MedusaContainer);
  await jest.runAllTimersAsync();
  await running;
  expect(pcFetch).toHaveBeenCalledWith('/api/product', { id: '9999' });
  expect(packs.applyCardPriceSync).toHaveBeenCalledWith(
    current,
    expect.objectContaining({
      id: 'card',
      market_value: 47.5,
      pc_pending_price: null,
    }),
  );
});

it('syncs the least recently synced cards first, so a sweep cut short leaves different cards behind next time', async () => {
  jest.useFakeTimers();
  const card = (id: string, pc_synced_at: string | null) => ({
    id,
    handle: id,
    pc_product_id: id,
    pc_grade: 'PSA 10',
    market_value: 1,
    pc_synced_at,
  });
  const cards = [
    card('fresh', '2026-11-11T03:10:00Z'),
    card('never', null),
    card('cut-twice', '2026-11-09T03:30:00Z'),
    card('cut-once', '2026-11-10T03:30:00Z'),
  ];
  const packs = {
    listCards: jest.fn(async (filter: { id?: string }) =>
      filter.id ? cards.filter((c) => c.id === filter.id) : cards,
    ),
    applyCardPriceSync: jest.fn().mockResolvedValue(true),
    listSiteSettings: jest.fn(async () => []),
    listCardPriceHistories: jest.fn(async () => [{ value: 1 }]),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  jest.mocked(pcFetch).mockImplementation(async (_path, params) => ({
    kind: 'ok',
    data: { status: 'success', id: params.id, 'manual-only-price': 100 },
  }));
  const running = runMarketPriceSync({
    resolve: (key: string) => (key === PACKS_MODULE ? packs : logger),
  } as unknown as MedusaContainer);
  await jest.runAllTimersAsync();
  await running;
  expect(jest.mocked(pcFetch).mock.calls.map(([, p]) => p.id)).toEqual([
    'never',
    'cut-twice',
    'cut-once',
    'fresh',
  ]);
});

it('returns before the sweep ends (frees the shared job slot) and skips a second sweep while one runs', async () => {
  jest.useFakeTimers();
  const cards = [
    {
      id: 'c',
      handle: 'c',
      pc_product_id: '1',
      pc_grade: 'PSA 10',
      market_value: 1,
    },
  ];
  const packs = {
    listCards: jest.fn(async () => cards),
    listFxRates: jest.fn(async () => [{ id: 'fx' }]),
    updateFxRates: jest.fn(),
    applyCardPriceSync: jest.fn().mockResolvedValue(true),
    listSiteSettings: jest.fn(async () => []),
    listCardPriceHistories: jest.fn(async () => [{ value: 1 }]),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const quote = { status: 'success', id: '1', 'manual-only-price': 100 };
  jest.mocked(pcFetch).mockResolvedValue({ kind: 'ok', data: quote });
  const container = {
    resolve: (key: string) => (key === PACKS_MODULE ? packs : logger),
  } as unknown as MedusaContainer;

  await syncMarketPricesJob(container); // resolves while the 1.1 s per-card wait is still pending
  expect(logger.info).not.toHaveBeenCalledWith(expect.stringMatching(/done:/));
  await syncMarketPricesJob(container);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringMatching(/still running/),
  );

  await jest.runAllTimersAsync();
  expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/done: /));
  expect(pcFetch).toHaveBeenCalledTimes(1); // the skipped call started no second sweep
});

describe('PriceCharting feed outage', () => {
  const setup = (stored: unknown = null) => {
    const cards = ['a', 'b', 'c'].map((id) => ({
      id,
      handle: id,
      pc_product_id: id,
      pc_grade: 'PSA 10',
      market_value: 1,
    }));
    const packs = {
      listCards: jest.fn(async (filter: { id?: string }) =>
        filter.id ? cards.filter((c) => c.id === filter.id) : cards,
      ),
      applyCardPriceSync: jest.fn().mockResolvedValue(true),
      listCardPriceHistories: jest.fn(async () => [{ value: 1 }]),
      listSiteSettings: jest.fn(async () => [
        { id: 'global', pricecharting_feed: stored },
      ]),
      updateSiteSettings: jest.fn(),
      createSiteSettings: jest.fn(),
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const run = async () => {
      jest.useFakeTimers();
      const running = runMarketPriceSync({
        resolve: (key: string) => (key === PACKS_MODULE ? packs : logger),
      } as unknown as MedusaContainer);
      await jest.runAllTimersAsync();
      await running;
    };
    return { packs, logger, run };
  };

  it('stops the sweep on the first expired-token reply: one request, one error, no card stamped', async () => {
    const { packs, logger, run } = setup();
    jest.mocked(pcFetch).mockResolvedValue({
      kind: 'error',
      message: 'Access token has expired',
      cause: 'auth',
    });
    await run();
    expect(pcFetch).toHaveBeenCalledTimes(1);
    expect(packs.applyCardPriceSync).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /Access token has expired.*PRICECHARTING_API_TOKEN/,
      ),
    );
    expect(packs.updateSiteSettings).toHaveBeenCalledWith({
      selector: { id: 'global' },
      data: {
        pricecharting_feed: {
          status: 'token_expired',
          message: 'Access token has expired',
          at: expect.any(String),
        },
      },
    });
  });

  it('records a missing token the same way, creating the settings row if absent', async () => {
    const { packs, run } = setup();
    packs.listSiteSettings.mockResolvedValue([]);
    jest.mocked(pcFetch).mockResolvedValue({ kind: 'no-token' });
    await run();
    expect(pcFetch).toHaveBeenCalledTimes(1);
    expect(packs.createSiteSettings).toHaveBeenCalledWith([
      {
        id: 'global',
        pricecharting_feed: expect.objectContaining({ status: 'no_token' }),
      },
    ]);
  });

  it('clears a stored outage once, on the first reply that proves the token works', async () => {
    const { packs, run } = setup({
      status: 'token_expired',
      message: 'x',
      at: 'y',
    });
    jest
      .mocked(pcFetch)
      .mockResolvedValueOnce({
        kind: 'error',
        message: 'PriceCharting did not respond — try again.',
        cause: 'unavailable',
      })
      .mockImplementation(async (_path, params) => ({
        kind: 'ok',
        data: { status: 'success', id: params.id, 'manual-only-price': 100 },
      }));
    await run();
    expect(pcFetch).toHaveBeenCalledTimes(3);
    expect(packs.updateSiteSettings).toHaveBeenCalledTimes(1);
    expect(packs.updateSiteSettings).toHaveBeenCalledWith({
      selector: { id: 'global' },
      data: { pricecharting_feed: null },
    });
    // Cleared right after the first ok (call 2), before the next card's fetch.
    const fetchOrder = jest.mocked(pcFetch).mock.invocationCallOrder;
    const clearAt = packs.updateSiteSettings.mock.invocationCallOrder[0];
    expect(clearAt).toBeGreaterThan(fetchOrder[1]);
    expect(clearAt).toBeLessThan(fetchOrder[2]);
    // The timed-out card was written (error kept visible), the rest synced.
    expect(packs.applyCardPriceSync).toHaveBeenCalledTimes(3);
  });

  const storedOutage = { status: 'token_expired', message: 'x', at: 'y' };
  const cleared = {
    selector: { id: 'global' },
    data: { pricecharting_feed: null },
  };
  const okReplies = () =>
    jest.mocked(pcFetch).mockImplementation(async (_path, params) => ({
      kind: 'ok',
      data: { status: 'success', id: params.id, 'manual-only-price': 100 },
    }));

  it('keeps a stored outage while every reply is a timeout', async () => {
    const { packs, run } = setup(storedOutage);
    jest.mocked(pcFetch).mockResolvedValue({
      kind: 'error',
      message: 'PriceCharting did not respond — try again.',
      cause: 'unavailable',
    });
    await run();
    expect(pcFetch).toHaveBeenCalledTimes(3);
    expect(packs.updateSiteSettings).not.toHaveBeenCalledWith(cleared);
  });

  it('keeps a stored outage while the token is still rejected, refreshing it once', async () => {
    const { packs, run } = setup(storedOutage);
    jest.mocked(pcFetch).mockResolvedValue({
      kind: 'error',
      message: 'Access token has expired',
      cause: 'auth',
    });
    await run();
    expect(packs.updateSiteSettings).toHaveBeenCalledTimes(1);
    expect(packs.updateSiteSettings).toHaveBeenCalledWith({
      selector: { id: 'global' },
      data: {
        pricecharting_feed: expect.objectContaining({
          status: 'token_expired',
        }),
      },
    });
    expect(packs.updateSiteSettings).not.toHaveBeenCalledWith(cleared);
  });

  it('does not take a card-level error as proof the token works', async () => {
    const { packs, run } = setup(storedOutage);
    okReplies().mockResolvedValueOnce({
      kind: 'error',
      message: 'No such product',
    });
    await run();
    expect(packs.updateSiteSettings).toHaveBeenCalledWith(cleared);
    const fetchOrder = jest.mocked(pcFetch).mock.invocationCallOrder;
    const clearAt = packs.updateSiteSettings.mock.invocationCallOrder[0];
    expect(clearAt).toBeGreaterThan(fetchOrder[1]);
    expect(clearAt).toBeLessThan(fetchOrder[2]);
  });

  it('retries a failed clear on the next card without failing the card', async () => {
    const { packs, logger, run } = setup(storedOutage);
    okReplies();
    packs.updateSiteSettings.mockRejectedValueOnce(new Error('db down'));
    await run();
    expect(packs.applyCardPriceSync).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/could not clear the feed alert/),
    );
    expect(packs.updateSiteSettings).toHaveBeenCalledTimes(2);
    expect(packs.updateSiteSettings).toHaveBeenNthCalledWith(2, cleared);
  });

  it('still sweeps when the stored alert cannot be read, clearing on the first ok', async () => {
    const { packs, logger, run } = setup();
    packs.listSiteSettings.mockRejectedValueOnce(new Error('db down'));
    okReplies();
    await run();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/could not read the feed alert/),
    );
    expect(pcFetch).toHaveBeenCalledTimes(3);
    expect(packs.updateSiteSettings).toHaveBeenCalledWith(cleared);
  });

  it('logs a lost outage alert and still finishes when it cannot be saved', async () => {
    const { packs, logger, run } = setup();
    jest.mocked(pcFetch).mockResolvedValue({
      kind: 'error',
      message: 'Access token has expired',
      cause: 'auth',
    });
    packs.updateSiteSettings.mockRejectedValue(new Error('db down'));
    await expect(run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/NOT recorded/),
    );
  });
});
