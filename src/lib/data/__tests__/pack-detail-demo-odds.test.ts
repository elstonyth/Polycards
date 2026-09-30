import { describe, it, expect, vi, beforeEach } from 'vitest';

// The guest demo spin draws on odds SET 3, which reaches the storefront as the
// backend's `demo_odds`. Nothing on screen shows which odds the demo rolled —
// a broken mapping just silently degrades to the published display odds — so
// the wiring is pinned here. The detail read goes through the `Store` port;
// the real parse path runs over an in-memory backend.
import { storeShim, backend } from '@/lib/__tests__/store-shim';

vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getPackDetail } from '@/lib/data/packs';
import { clearTtlCache } from '@/lib/ttl-cache';

// getPackDetail memoises per slug; each case scripts its own backend body.
beforeEach(() => clearTtlCache());

const ODDS_ROW = {
  handle: 'charizard-psa-10',
  name: 'Charizard PSA 10',
  rarity: 'Legendary',
  market_value: 100,
  marketPriceMyr: 400,
  image: '/charizard.webp',
};

const detail = async (over: Record<string, unknown>) => {
  backend({
    'GET /store/packs/:slug': { body: { odds: [ODDS_ROW], ...over } },
  });
  return getPackDetail('bronze-pack');
};

describe('pack detail: demo odds', () => {
  it('maps demo_odds tiers onto demoOdds', async () => {
    const d = await detail({
      demo_odds: { tiers: { Legendary: 12.5, Common: 87.5 } },
      published_odds: { tiers: { Legendary: 1 } },
    });
    expect(d?.demoOdds).toEqual({ tiers: { Legendary: 12.5, Common: 87.5 } });
    // The published display odds are a SEPARATE field and must not be replaced.
    expect(d?.publishedOdds).toEqual({ tiers: { Legendary: 1 } });
  });

  // An older backend (or a pack whose set 3 is indistinguishable from set 1)
  // sends nothing — the demo falls back to the published odds rather than
  // breaking.
  it('is null when the backend omits the field', async () => {
    const d = await detail({ published_odds: { tiers: { Legendary: 1 } } });
    expect(d?.demoOdds).toBeNull();
  });

  // jsonb passthrough: the same trust-boundary sanitizer as published_odds.
  it('drops unknown tiers and out-of-range percentages', async () => {
    const d = await detail({
      demo_odds: { tiers: { Legendary: 50, Bogus: 30, Common: 200 } },
    });
    expect(d?.demoOdds).toEqual({ tiers: { Legendary: 50 } });
  });
});

// Every SSR, price poll and highlights refresh used to pay a backend hop and a
// full-pool parse; the paid packs' detail reads were the slowest store route.
describe('pack detail: per-process memo', () => {
  it('serves repeat reads of one pack from a single backend call', async () => {
    const mem = backend({
      'GET /store/packs/:slug': { body: { odds: [ODDS_ROW] } },
    });
    const first = await getPackDetail('bronze-pack');
    const second = await getPackDetail('bronze-pack');
    expect(second).toEqual(first);
    expect(mem.requests).toHaveLength(1);
  });

  // A miss must not be held for the window: a pack going live would stay
  // hidden, and garbage slugs from the public route would fill the memo.
  it('does not remember a miss', async () => {
    const miss = backend({ 'GET /store/packs/:slug': { status: 404 } });
    expect(await getPackDetail('bronze-pack')).toBeNull();
    expect(miss.requests).toHaveLength(1);

    backend({ 'GET /store/packs/:slug': { body: { odds: [ODDS_ROW] } } });
    expect((await getPackDetail('bronze-pack'))?.pool).toHaveLength(1);
  });
});
