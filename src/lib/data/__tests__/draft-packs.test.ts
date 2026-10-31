import { describe, it, expect, vi, beforeEach } from 'vitest';

// Draft packs reach a member of a staff group through their own authed routes. The
// rule that matters: a draft is never written to a memo every visitor reads, and a
// guest or an ordinary pack view costs the backend no extra request.
import { storeShim, backend } from '@/lib/__tests__/store-shim';

vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('next/cache', () => ({
  unstable_cache: <F>(fn: F) => fn,
}));

import {
  getDraftPackDetail,
  getPackBaseForViewer,
  getPackCategories,
  getPackCategoriesForViewer,
} from '@/lib/data/packs';
import { clearTtlCache } from '@/lib/ttl-cache';

beforeEach(() => clearTtlCache());

const LIST = '/store/customers/me/draft-packs';

const row = (slug: string, status: string, extra = {}) => ({
  slug,
  title: slug,
  category: 'poly',
  price: 40,
  image: `/${slug}.webp`,
  boost: false,
  rank: 0,
  status,
  prize_type: 'tickets',
  ...extra,
});
const LIVE = row('silver-capsule', 'active');
const DRAFT = row('gold-capsule', 'draft');

const serve = (drafts: unknown[] | null, token: string | null = 'jwt') =>
  backend(
    {
      'GET /store/packs': { body: { packs: [LIVE] } },
      'GET /store/packs/:slug': { status: 404, body: { message: 'not found' } },
      [`GET ${LIST}`]:
        drafts === null
          ? { status: 500, body: { message: 'boom' } }
          : { body: { packs: drafts } },
    },
    { token },
  );

const poly = (cats: Awaited<ReturnType<typeof getPackCategories>>) =>
  cats.find((c) => c.id === 'poly')?.packs ?? [];
const asked = (b: ReturnType<typeof serve>, path: string) =>
  b.requests.some((r) => r.path === path);

describe('getPackCategoriesForViewer', () => {
  it('adds a member their drafts, marked, after the live packs', async () => {
    serve([DRAFT]);
    const packs = poly(await getPackCategoriesForViewer());
    expect(packs.map((p) => [p.id, p.draft])).toEqual([
      ['silver-capsule', undefined],
      ['gold-capsule', true],
    ]);
  });

  it('never writes a draft into the catalog memo every visitor reads', async () => {
    serve([DRAFT]);
    await getPackCategoriesForViewer();
    expect(poly(await getPackCategories()).map((p) => p.id)).toEqual([
      'silver-capsule',
    ]);
  });

  it('sends a guest no draft request at all', async () => {
    const b = serve([DRAFT], null);
    const packs = poly(await getPackCategoriesForViewer());
    expect(packs.map((p) => p.id)).toEqual(['silver-capsule']);
    expect(asked(b, LIST)).toBe(false);
  });

  it('a failed draft read keeps the catalog', async () => {
    serve(null);
    const packs = poly(await getPackCategoriesForViewer());
    expect(packs.map((p) => p.id)).toEqual(['silver-capsule']);
  });

  it('gives a draft in a category with no live packs its own tab', async () => {
    serve([row('new-pack', 'draft', { category: 'mystery' })]);
    const cats = await getPackCategoriesForViewer();
    const mystery = cats.find((c) => c.id === 'mystery');
    expect(mystery?.tab).toBe('Mystery');
    expect(mystery?.packs.map((p) => p.id)).toEqual(['new-pack']);
  });
});

describe('getPackBaseForViewer', () => {
  it('a live pack costs no draft request', async () => {
    const b = serve([DRAFT]);
    const base = await getPackBaseForViewer('silver-capsule');
    expect(base?.pack.id).toBe('silver-capsule');
    expect(base?.pack.draft).toBeUndefined();
    expect(asked(b, LIST)).toBe(false);
  });

  it('finds a draft for a member, with its category and siblings', async () => {
    serve([DRAFT]);
    const base = await getPackBaseForViewer('gold-capsule');
    expect(base?.pack.draft).toBe(true);
    expect(base?.pack.categoryId).toBe('poly');
    expect(base?.siblings.map((p) => p.id)).toEqual([
      'silver-capsule',
      'gold-capsule',
    ]);
  });

  it('is nothing for a guest or a non-member', async () => {
    serve([DRAFT], null);
    expect(await getPackBaseForViewer('gold-capsule')).toBeNull();
    serve([]);
    expect(await getPackBaseForViewer('gold-capsule')).toBeNull();
  });
});

describe('getDraftPackDetail', () => {
  const route = `GET ${LIST}/:slug`;

  it('reads the draft route, not the public one', async () => {
    const b = backend(
      {
        [route]: {
          body: {
            prize_type: 'tickets',
            odds: [{ tickets: 100, rarity: 'Rare' }],
            published_odds: { tiers: { Rare: 100 } },
            demo_odds: null,
          },
        },
      },
      { token: 'jwt' },
    );
    const d = await getDraftPackDetail('gold-capsule');
    expect(d?.pool.map((c) => c.tickets)).toEqual([100]);
    expect(d?.publishedOdds).toEqual({ tiers: { Rare: 100 } });
    expect(asked(b, `${LIST}/gold-capsule`)).toBe(true);
  });

  it('is nothing on a refusal', async () => {
    backend(
      { [route]: { status: 404, body: { message: 'not found' } } },
      { token: 'jwt' },
    );
    expect(await getDraftPackDetail('gold-capsule')).toBeNull();
  });

  it('asks nothing for a guest', async () => {
    const b = backend({}, { token: null });
    expect(await getDraftPackDetail('gold-capsule')).toBeNull();
    expect(b.requests).toHaveLength(0);
  });
});
