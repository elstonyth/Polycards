import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// The loaders read through the `Store` port; an in-memory backend seeds them
// so the real getPackCategories/getPullGaps parse path runs and both the key
// gate and the schema boundary are exercised. rarity/pack_id now ride the
// port's `query` option instead of a hand-built querystring — same URL on the
// wire, so the assertions read `request.query`.
import { storeShim, backend } from '@/lib/__tests__/store-shim';
import type { MemoryRoutes } from '@/lib/store-memory';

vi.mock('@/lib/store', () => ({ store: storeShim }));
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
const seed = (over: MemoryRoutes = {}) =>
  backend({
    'GET /store/packs': { body: { packs: [packRow] } },
    'GET /store/packs/:slug': { status: 404, body: { message: 'not found' } },
    'GET /store/pulls/gaps': { body: gapsBody },
    ...over,
  });

let mem: ReturnType<typeof seed>;
const gapsCallsOf = () =>
  mem.requests.filter((r) => r.path === '/store/pulls/gaps');

beforeEach(() => {
  clearTtlCache();
  mem = seed();
});

describe('GET /api/pull-gaps', () => {
  it('forwards a real pack + known tier on their own key; garbage collapses to global/apex', async () => {
    await GET(req('?pack_id=bronze-pack&rarity=Legendary'));
    await GET(req('?pack_id=not-a-pack&rarity=Shiny'));
    await GET(req());

    // rarity first, then pack_id — the order the hand-built querystring had.
    expect(gapsCallsOf().map((r) => Object.entries(r.query!))).toEqual([
      [
        ['rarity', 'Legendary'],
        ['pack_id', 'bronze-pack'],
      ],
      [['rarity', 'Immortal']],
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
        avatar: '/images/pfps/pfp-8.webp',
        frame: null,
      },
    ]);
  });

  it('a malformed body is a 503 null that is NOT memoised (the next request retries)', async () => {
    mem = seed({
      'GET /store/pulls/gaps': { body: { rarity: 'Immortal', hits: 'nope' } },
    });
    const bad = await GET(req());
    expect(bad.status).toBe(503);
    expect(await bad.json()).toBeNull();

    // The backend recovers inside the same 5s window — a memoised null would
    // have kept every viewer on "unavailable" until it expired.
    mem = seed();
    const good = await GET(req());
    expect(good.status).toBe(200);
    expect((await good.json()).current).toBe(27);
  });
});
