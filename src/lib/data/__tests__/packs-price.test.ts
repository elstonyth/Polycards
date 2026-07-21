import { describe, it, expect, vi, beforeEach } from 'vitest';

// A Pack carries TWO prices: `price` is a rounded display string ("RM 2") and
// `priceValue` is the raw number the client charges and gates on. They were
// once the same value, because the cost model re-parsed the display string --
// so a RM 1.50 pack displayed "RM 2", refused to spin under RM 2, and charged
// RM 1.50. Today's catalog is whole-ringgit, so nothing in the app would notice
// a regression to that. This test is the tripwire. sdk + logger are mocked; the
// real schema/parse path runs.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('@/lib/medusa', () => ({ sdk: { client: { fetch: fetchMock } } }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getPackCategories } from '@/lib/data/packs';

const row = (over: Record<string, unknown> = {}) => ({
  slug: 'bronze-pack',
  title: 'Bronze Pack',
  category: 'bronze',
  price: 1.5,
  image: '/bronze.webp',
  display_image: null,
  boost: false,
  rank: 1,
  buyback_percent: 90,
  in_stock: true,
  ...over,
});

const firstPack = async () => {
  const cats = await getPackCategories();
  const pack = cats.flatMap((c) => c.packs)[0];
  if (!pack) throw new Error('expected the fixture row to survive parsing');
  return pack;
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe('pack price: display vs charge', () => {
  it('keeps the exact backend price in priceValue for a fractional price', async () => {
    fetchMock.mockResolvedValue({ packs: [row({ price: 1.5 })] });
    const pack = await firstPack();

    // The number every money decision reads: affordability, bet meter,
    // shortfall math. Must be the backend value, never the rounded string.
    expect(pack.priceValue).toBe(1.5);
    // Regression guard: re-parsing the display string yielded 2.
    expect(pack.priceValue).not.toBe(2);
  });

  it('rounds only the display string, and rounds half-up', async () => {
    fetchMock.mockResolvedValue({ packs: [row({ price: 1.5 })] });
    expect((await firstPack()).price).toBe('RM 2');
  });

  it('does not change display for whole-ringgit prices', async () => {
    fetchMock.mockResolvedValue({ packs: [row({ price: 25 })] });
    const pack = await firstPack();
    expect(pack.price).toBe('RM 25');
    expect(pack.priceValue).toBe(25);
  });

  it('rounds a fractional price DOWN in display while charging the real value', async () => {
    // The direction that under-displays: 1.4 shows as "RM 1", charges 1.40.
    fetchMock.mockResolvedValue({ packs: [row({ price: 1.4 })] });
    const pack = await firstPack();
    expect(pack.price).toBe('RM 1');
    expect(pack.priceValue).toBe(1.4);
  });

  it('drops rows whose price is not finite rather than emitting NaN money', async () => {
    fetchMock.mockResolvedValue({
      packs: [
        row({ slug: 'bad-null', price: null }),
        row({ slug: 'bad-string', price: '5' }),
        row({ slug: 'good', price: 3 }),
      ],
    });
    const packs = (await getPackCategories()).flatMap((c) => c.packs);

    expect(packs.map((p) => p.id)).toEqual(['good']);
    expect(packs.every((p) => Number.isFinite(p.priceValue))).toBe(true);
  });
});
