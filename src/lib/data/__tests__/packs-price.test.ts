import { describe, it, expect, vi, beforeEach } from 'vitest';

// A Pack carries ONE price, `priceMyr`: the raw number the client charges and
// gates on. The tiles round it for the eye with rm0() at the render edge
// ("RM 2" for 1.5). It used to carry a pre-rounded display string too, and
// the cost model once re-parsed that -- so a RM 1.50 pack displayed "RM 2",
// refused to spin under RM 2, and charged RM 1.50. Today's catalog is
// whole-ringgit, so nothing in the app would notice a regression to that.
// This test is the tripwire. The catalog reads through the `Store` port, so an
// in-memory backend seeds it and the real schema/parse path runs.
import { storeShim, backend } from '@/lib/__tests__/store-shim';

vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getPackCategories, getPackBySlug } from '@/lib/data/packs';
import { clearTtlCache } from '@/lib/ttl-cache';
import { rm0 } from '@/lib/format';

const PACKS = 'GET /store/packs';
const seed = (body: unknown) => backend({ [PACKS]: { body } });

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
  // getPackCategories is memoised per process for one backend cache window, so
  // without this the FIRST fixture's catalog is served to every later case.
  clearTtlCache();
});

describe('pack price: display vs charge', () => {
  it('keeps the exact backend price in priceMyr for a fractional price', async () => {
    seed({ packs: [row({ price: 1.5 })] });
    const pack = await firstPack();

    // The number every money decision reads: affordability, bet meter,
    // shortfall math. Must be the backend value, never a rounded figure.
    expect(pack.priceMyr).toBe(1.5);
    // Regression guard: re-parsing the display string yielded 2.
    expect(pack.priceMyr).not.toBe(2);
  });

  it('rounds only at the render edge, and rounds half-up', async () => {
    seed({ packs: [row({ price: 1.5 })] });
    expect(rm0((await firstPack()).priceMyr)).toBe('RM 2');
  });

  it('does not change display for whole-ringgit prices', async () => {
    seed({ packs: [row({ price: 25 })] });
    const pack = await firstPack();
    expect(rm0(pack.priceMyr)).toBe('RM 25');
    expect(pack.priceMyr).toBe(25);
  });

  it('rounds a fractional price DOWN in display while charging the real value', async () => {
    // The direction that under-displays: 1.4 shows as "RM 1", charges 1.40.
    seed({ packs: [row({ price: 1.4 })] });
    const pack = await firstPack();
    expect(rm0(pack.priceMyr)).toBe('RM 1');
    expect(pack.priceMyr).toBe(1.4);
  });

  it('drops rows whose price is not finite rather than emitting NaN money', async () => {
    seed({
      packs: [
        row({ slug: 'bad-null', price: null }),
        row({ slug: 'bad-string', price: '5' }),
        row({ slug: 'good', price: 3 }),
      ],
    });
    const packs = (await getPackCategories()).flatMap((c) => c.packs);

    expect(packs.map((p) => p.id)).toEqual(['good']);
    expect(packs.every((p) => Number.isFinite(p.priceMyr))).toBe(true);
  });

  it('does not serve a failed catalog for the rest of the cache window', async () => {
    // The catalog is memoised for 30s. If the degradation were caught INSIDE
    // the memo, the empty fallback would resolve successfully and be served for
    // the whole window — one blip would blank /slots for 30s. It is caught
    // outside instead, so the rejection evicts and the next read retries.
    backend({ [PACKS]: { status: 502, body: { message: 'backend down' } } });
    expect((await getPackCategories()).flatMap((c) => c.packs)).toEqual([]);

    seed({ packs: [row()] });
    const packs = (await getPackCategories()).flatMap((c) => c.packs);
    expect(packs.map((p) => p.id)).toEqual(['bronze-pack']);
  });
});

describe('the catalog request', () => {
  it('is public: no bearer, and no cache key on the wire', async () => {
    // The home page prerenders this catalog under `revalidate = 15`; an
    // explicit cache mode would make that route dynamic.
    const mem = seed({ packs: [] });
    await getPackCategories();
    expect(mem.requests[0]).toEqual({
      method: 'GET',
      path: '/store/packs',
      headers: {},
      cache: 'auto',
    });
  });
});

// The UNLISTED pack path: GET /store/packs filters `free_welcome` out, so the
// free welcome pack resolves through the detail route instead of the catalog.
describe('getPackBySlug — the unlisted (uncataloged) pack', () => {
  const unlisted = (over: Record<string, unknown> = {}) =>
    backend({
      'GET /store/packs': { body: { packs: [] } },
      'GET /store/packs/:slug': {
        body: {
          pack: row({
            slug: 'free-welcome-pack',
            category: 'free_welcome',
            ...over,
          }),
        },
      },
    });

  it('resolves through the detail route, with no siblings', async () => {
    unlisted();
    const base = await getPackBySlug('free-welcome-pack');
    expect(base?.pack.id).toBe('free-welcome-pack');
    expect(base?.pack.categoryId).toBe('free_welcome');
    // Title-cased from the key: the local meta has no `free_welcome` entry.
    expect(base?.pack.categoryName).toBe('Free Welcome');
    expect(base?.siblings).toEqual([]);
  });

  it('null when the detail route 404s it too', async () => {
    backend({
      'GET /store/packs': { body: { packs: [] } },
      'GET /store/packs/:slug': { status: 404, body: { message: 'nope' } },
    });
    expect(await getPackBySlug('nope')).toBeNull();
  });

  // DECLARED BEHAVIOUR CHANGE (Task 3). Pre-port this path validated the row
  // and then threw the PARSED result away, mapping the RAW body — so an
  // out-of-enum `group` leaked straight through to Pack.group. It now maps the
  // parsed row, where PackRowSchema's `.catch(null)` has already degraded it.
  // Narrow (only an unlisted pack reaches here), in the safe direction, and it
  // makes this path match the list path, which always mapped parsed rows.
  it('degrades an out-of-enum group to null instead of leaking it', async () => {
    unlisted({ group: 'BOGUS' });
    expect((await getPackBySlug('free-welcome-pack'))?.pack.group).toBeNull();
  });

  it('still carries a legitimate group through', async () => {
    unlisted({ group: 'GRADED' });
    expect((await getPackBySlug('free-welcome-pack'))?.pack.group).toBe(
      'GRADED',
    );
  });
});
