import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from '@medusajs/js-sdk';

// getCardResult's job is to distinguish WHY it returned no card: a 404 (unknown
// handle) → the page 404s, but any transient failure (5xx, network,
// schema-invalid) → a retry state, never "Card not found" for a card the
// customer may actually own. sdk + logger are mocked; the real
// parseOne/CardDetailSchema run so schema validation is genuine.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('@/lib/medusa', () => ({ sdk: { client: { fetch: fetchMock } } }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getCard, getCardResult } from '@/lib/data/cards';

const validCard = {
  handle: 'db-charizard',
  name: 'Charizard',
  set: 'Base Set',
  grader: 'PSA',
  grade: '10',
  image: '/x.webp',
  slab_image: null,
  marketPriceMyr: 1234.5,
  rarity: 'Legendary',
  pcSyncedAt: null,
  priceHistory: [],
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe('getCardResult', () => {
  it('returns { status: "ok", card } for a valid response', async () => {
    fetchMock.mockResolvedValue({ card: validCard });
    const res = await getCardResult('db-charizard');
    expect(res).toEqual({ status: 'ok', card: validCard });
  });

  it('returns { status: "notfound" } on a 404 (genuine miss → page 404s)', async () => {
    fetchMock.mockRejectedValue(new FetchError('nope', 'Not Found', 404));
    expect(await getCardResult('nobody')).toEqual({ status: 'notfound' });
  });

  it('returns { status: "error" } on a 5xx (outage → NOT a 404)', async () => {
    fetchMock.mockRejectedValue(new FetchError('boom', 'Server Error', 500));
    expect(await getCardResult('db-charizard')).toEqual({ status: 'error' });
  });

  it('returns { status: "error" } on a network-style throw', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await getCardResult('db-charizard')).toEqual({ status: 'error' });
  });

  it('returns { status: "error" } on a schema-invalid response', async () => {
    fetchMock.mockResolvedValue({ card: { handle: 'x', name: 'X' } });
    expect(await getCardResult('x')).toEqual({ status: 'error' });
  });
});

describe('getCard (null-returning view kept for /api/cards)', () => {
  it('returns the card when found', async () => {
    fetchMock.mockResolvedValue({ card: validCard });
    expect(await getCard('db-charizard')).toEqual(validCard);
  });

  it('returns null for both a 404 and an outage', async () => {
    fetchMock.mockRejectedValue(new FetchError('nope', 'Not Found', 404));
    expect(await getCard('nobody')).toBeNull();
    fetchMock.mockRejectedValue(new FetchError('boom', 'Server Error', 500));
    expect(await getCard('db-charizard')).toBeNull();
  });
});
