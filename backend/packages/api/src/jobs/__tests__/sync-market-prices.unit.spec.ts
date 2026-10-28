import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../modules/packs';
import { pcFetch } from '../../api/admin/pricecharting/client';
import syncMarketPricesJob from '../sync-market-prices';

jest.mock('../../api/admin/pricecharting/client', () => ({
  pcFetch: jest.fn(),
}));
jest.mock('../../modules/packs/pricing', () => ({
  fetchUsdMyr: jest.fn(async () => 4.1),
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
    listCardPriceHistories: jest.fn(async () => [{ value: 100 }]),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const quote = { status: 'success', id: '6910', 'manual-only-price': 10000 };
  jest
    .mocked(pcFetch)
    .mockRejectedValueOnce(new Error('internal URL with secret'))
    .mockResolvedValueOnce({ kind: 'ok', data: quote });
  const running = syncMarketPricesJob({
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
    listCardPriceHistories: jest.fn(async () => [{ value: 47.5 }]),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const quote = { status: 'success', id: '9999', 'manual-only-price': 4750 };
  jest.mocked(pcFetch).mockResolvedValueOnce({ kind: 'ok', data: quote });
  const running = syncMarketPricesJob({
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
