import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// sdk + logger are mocked; the real getPackCategories/getPullGaps parse path
// runs, so the key gate and the schema boundary are exercised for real.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/medusa', () => ({ sdk: { client: { fetch: fetchMock } } }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { GET } from '@/app/api/pull-gaps/route';
import { clearTtlCache } from '@/lib/ttl-cache';

const packRow = {
  slug: 'bronze-pack',
  title: 'Bronze Pack',
  category: 'pokemon',
  price: 10,
  image: '/bronze.webp',
  display_image: null,
  boost: false,
  rank: 1,
  buyback_percent: 90,
  in_stock: true,
};

const gapsBody = {
  rarity: 'Immortal',
  pct: 1.1,
  expected: 91,
  avg: 60.5,
  last20: 86,
  current: 27,
  hits: [{ id: 'p1', gap: 42, rolled_at: '2026-09-02T13:38:44.000Z', seed: 7 }],
};

const req = (query = '') =>
  new NextRequest(`http://localhost/api/pull-gaps${query}`);
const gapsCallsOf = () =>
  fetchMock.mock.calls.filter(([path]) =>
    String(path).startsWith('/store/pulls/gaps'),
  );

beforeEach(() => {
  fetchMock.mockReset();
  clearTtlCache();
  fetchMock.mockImplementation(async (path: string) => {
    if (path.startsWith('/store/packs')) return { packs: [packRow] };
    if (path.startsWith('/store/pulls/gaps')) return gapsBody;
    throw new Error(`unexpected fetch path in test: ${path}`);
  });
});

describe('GET /api/pull-gaps', () => {
  it('forwards a real pack + known tier on their own key; garbage collapses to global/apex', async () => {
    await GET(req('?pack_id=bronze-pack&rarity=Legendary'));
    await GET(req('?pack_id=not-a-pack&rarity=Shiny'));
    await GET(req());

    expect(gapsCallsOf().map(([p]) => p)).toEqual([
      '/store/pulls/gaps?rarity=Legendary&pack_id=bronze-pack',
      '/store/pulls/gaps?rarity=Immortal',
    ]);
  });

  it('maps the body into the chart shape (seed → avatar, nullable header numbers)', async () => {
    const body = await (await GET(req('?rarity=Immortal'))).json();
    expect(body).toMatchObject({
      rarity: 'Immortal',
      pct: 1.1,
      expected: 91,
      avg: 60.5,
      last20: 86,
      current: 27,
    });
    expect(body.hits).toEqual([
      {
        id: 'p1',
        gap: 42,
        rolledAt: '2026-09-02T13:38:44.000Z',
        who: 'Anonymous',
        profileHandle: null,
        avatar: '/images/pfps/pfp-8.webp',
        frame: null,
      },
    ]);
  });

  it('a malformed body is null, not a crash', async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/store/packs')) return { packs: [packRow] };
      return { rarity: 'Immortal', hits: 'nope' };
    });
    expect(await (await GET(req())).json()).toBeNull();
  });
});
