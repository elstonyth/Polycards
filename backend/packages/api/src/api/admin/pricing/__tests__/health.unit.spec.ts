import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { GET } from '../health/route';

const NOW = new Date('2026-10-17T03:00:00Z');
const pending = {
  product_id: '6910',
  grade: 'PSA 10',
  baseline_value: 875,
  proposed_value: 47.5,
  first_seen_at: '2026-10-16T03:00:00Z',
};
const card = (handle: string, changes: Record<string, unknown> = {}) => ({
  handle,
  name: handle,
  pc_product_id: '6910',
  pc_grade: 'PSA 10',
  market_value: 875,
  pc_synced_at: NOW,
  pc_pending_price: null,
  pc_sync_error: null,
  ...changes,
});

const run = async (
  cards: ReturnType<typeof card>[],
  missingProducts: string[] = [],
) => {
  const packs = {
    listCards: jest.fn(async (_filter, opts: { skip: number; take: number }) =>
      cards.slice(opts.skip, opts.skip + opts.take),
    ),
    listFxRates: jest.fn(async () => [
      { rate: 4.1, source: 'test', manual_override: false, fetched_at: NOW },
    ]),
  };
  const products = {
    listProducts: jest.fn(async () =>
      cards.filter((c) => !missingProducts.includes(c.handle)),
    ),
  };
  const json = jest.fn();
  await GET(
    {
      scope: {
        resolve: (key: string) => (key === Modules.PRODUCT ? products : packs),
      },
    } as unknown as MedusaRequest,
    { json } as unknown as MedusaResponse,
  );
  return json.mock.calls[0][0] as {
    fx: { rate: number };
    cards: {
      linked: number;
      pending_confirmation: number;
      unlinked: number;
      never_synced: number;
      stale_48h: number;
      missing_product: string[];
      issues: Array<{
        handle: string;
        reason: string;
        message: string | null;
        proposed_value: number | null;
      }>;
    };
  };
};

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime()));
afterEach(() => jest.restoreAllMocks());

it('surfaces pending and failed prices immediately, without duplicate stale issues', async () => {
  const result = await run(
    [
      card('pending', { pc_pending_price: pending, pc_synced_at: null }),
      card('failed', {
        pc_sync_error: 'no usable price',
        pc_synced_at: new Date('2026-10-01'),
      }),
      card('unlinked', { pc_product_id: null, pc_grade: null }),
      card('missing-grade', { pc_grade: null }),
      card('never', { pc_synced_at: null }),
      card('stale', { pc_synced_at: new Date('2026-10-01') }),
      card('missing-product'),
      card('healthy'),
    ],
    ['missing-product', 'pending'],
  );
  expect(result.cards).toMatchObject({
    linked: 7,
    pending_confirmation: 1,
    unlinked: 2,
    never_synced: 2,
    stale_48h: 2,
    missing_product: ['pending', 'missing-product'],
  });
  expect(result.cards.issues.map((i) => [i.handle, i.reason])).toEqual([
    ['pending', 'pending_confirmation'],
    ['failed', 'sync_error'],
    ['unlinked', 'unlinked'],
    ['missing-grade', 'unlinked'],
    ['never', 'never_synced'],
    ['stale', 'stale'],
    ['missing-product', 'missing_product'],
  ]);
  expect(result.cards.issues[0]).toMatchObject({
    proposed_value: 47.5,
    first_seen_at: pending.first_seen_at,
    market_value: 875,
  });
  expect(result.cards.issues[1]).toMatchObject({
    message: 'no usable price',
    proposed_value: null,
  });
  expect(result.fx.rate).toBe(4.1);
});

it('counts cards beyond the first page and ignores pending quotes for obsolete baselines', async () => {
  const cards = Array.from({ length: 1001 }, (_, i) => card(`card-${i}`));
  cards[1000] = card('last', {
    pc_pending_price: pending,
    market_value: 50,
    pc_synced_at: null,
  });
  const result = await run(cards);
  expect(result.cards.linked).toBe(1001);
  expect(result.cards.pending_confirmation).toBe(0);
  expect(result.cards.issues).toEqual([
    expect.objectContaining({
      handle: 'last',
      reason: 'never_synced',
      proposed_value: null,
    }),
  ]);
});
