import { describe, it, expect, vi, beforeEach } from 'vitest';

// The guest demo spin draws on odds SET 3, which reaches the storefront as the
// backend's `demo_odds`. Nothing on screen shows which odds the demo rolled —
// a broken mapping just silently degrades to the published display odds — so
// the wiring is pinned here. sdk + logger are mocked; the real parse path runs.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('@/lib/medusa', () => ({ sdk: { client: { fetch: fetchMock } } }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getPackDetail } from '@/lib/data/packs';

const ODDS_ROW = {
  handle: 'charizard-psa-10',
  name: 'Charizard PSA 10',
  rarity: 'Legendary',
  market_value: 100,
  marketPriceMyr: 400,
  image: '/charizard.webp',
};

const detail = async (over: Record<string, unknown>) => {
  fetchMock.mockResolvedValueOnce({ odds: [ODDS_ROW], ...over });
  return getPackDetail('bronze-pack');
};

beforeEach(() => {
  fetchMock.mockReset();
});

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
