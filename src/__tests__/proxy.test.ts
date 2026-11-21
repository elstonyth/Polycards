import { afterEach, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, isKnownRoute, proxy } from '@/proxy';

const FORM = 'application/x-www-form-urlencoded';
const matches = (url: string, headers: Record<string, string> = {}) =>
  unstable_doesMiddlewareMatch({ config, url, headers });

const post = (path: string, headers: Record<string, string>) =>
  proxy(
    new NextRequest(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body: 'a=1',
    }),
  );

describe('proxy matcher — every page path, never static files', () => {
  it('runs on pages, made-up paths and the polled APIs', () => {
    expect(matches('/')).toBe(true);
    expect(matches('/leaderboard/sda')).toBe(true);
    expect(matches('/api/pack-detail/bronze-pack')).toBe(true);
  });

  it('skips Next assets, public/ files and the other API routes', () => {
    expect(matches('/_next/static/chunks/app.js')).toBe(false);
    expect(matches('/images/polycards/gold-pack.webp')).toBe(false);
    expect(matches('/videos/factory.mp4')).toBe(false);
    // The home pack stage's bundled 3D pictures (public/pack-3d/<id>/).
    expect(matches('/pack-3d/x.webp')).toBe(false);
    expect(matches('/pack-3d/151/front-half.webp?v=4abf4574')).toBe(false);
    expect(matches('/api/me')).toBe(false);
    expect(matches('/api/presence')).toBe(false);
  });
});

describe('form POST to / — refused before rendering', () => {
  it('answers a form-encoded POST to / without Next-Action with 405', () => {
    const res = post('/', { 'content-type': FORM });
    expect(res?.status).toBe(405);
    expect(res?.headers.get('allow')).toBe('GET, HEAD');
  });

  it('passes real server actions, other content types and charsets', () => {
    expect(
      post('/', { 'content-type': FORM, 'next-action': 'abc123' }),
    ).toBeUndefined();
    expect(
      post('/', { 'content-type': 'text/plain;charset=UTF-8' }),
    ).toBeUndefined();
    // Next only treats the bare type as a possible action.
    expect(
      post('/', { 'content-type': `${FORM}; charset=UTF-8` }),
    ).toBeUndefined();
  });

  it('never touches other pages (a gateway may POST a form to /transactions)', () => {
    expect(post('/transactions', { 'content-type': FORM })).toBeUndefined();
    expect(
      post('/slots/bronze-pack', { 'content-type': FORM }),
    ).toBeUndefined();
  });

  it('lets a GET to / through untouched', () => {
    expect(
      proxy(
        new NextRequest('http://localhost/', {
          headers: { 'content-type': FORM },
        }),
      ),
    ).toBeUndefined();
  });
});

describe('unknown routes — a cacheable 404 before rendering', () => {
  const get = (path: string) =>
    proxy(new NextRequest(`https://polycards.gg${path}`));

  it('answers the 2026-10-25 flood paths and other made-up URLs', () => {
    for (const path of [
      '/leaderboard/sda',
      '/random',
      '/slots/a/b/c',
      '/wp-admin',
      '/vault/history/x',
    ]) {
      const res = get(path);
      expect(res?.status, path).toBe(404);
      expect(res?.headers.get('cache-control')).toBe('public, max-age=300');
    }
  });

  it('passes every real page, with or without a trailing slash or query', () => {
    for (const path of [
      '/',
      '/leaderboard',
      '/leaderboard/',
      '/slots',
      '/slots/bronze-pack',
      '/slots/bronze-pack/spin?count=3',
      '/slots/bronze-pack/share.jpg',
      '/card/pikachu-tg05-psa-10-4080757',
      '/card/pikachu-tg05-psa-10-4080757/share.jpg',
      '/profile/Collector7530',
      '/r/ZE42A7WA',
      '/vault',
      '/vault/history',
      '/auth/google/callback?state=x',
      '/healthz',
      '/robots.txt',
      '/sitemap.xml',
      '/manifest.webmanifest',
      '/icon.png?291a1666e62a259d',
      '/favicon.ico',
      '/lucky-draw',
      '/task',
      '/transactions?ref=gateway',
      '/home-preview',
      '/home-preview?loader=always&stage=flat',
      // TEMPORARY: the flow groundwork's preview route.
      '/flow-preview/gold-pack',
      '/flow-preview/gold-pack?from=stage',
    ]) {
      expect(get(path), path).toBeUndefined();
    }
  });

  it('lists every route src/app serves (add new pages to KNOWN_ROUTE)', () => {
    const root = join(process.cwd(), 'src', 'app');
    const routes: string[] = [];
    const walk = (dir: string, url: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name.startsWith('_')) continue;
        if (entry.isDirectory()) {
          const seg = entry.name.startsWith('(')
            ? ''
            : entry.name.startsWith('[')
              ? '/sample-segment-1'
              : `/${entry.name}`;
          walk(join(dir, entry.name), url + seg);
        } else if (/^(page|route)\.tsx?$/.test(entry.name)) {
          routes.push(url || '/');
        }
      }
    };
    walk(root, '');
    expect(routes.length).toBeGreaterThan(30);
    const missing = routes.filter(
      (r) => !r.startsWith('/api/') && !isKnownRoute(r),
    );
    expect(missing).toEqual([]);
  });
});

describe('polled public JSON — same-origin fetches only', () => {
  const get = (path: string, headers: Record<string, string> = {}) =>
    proxy(
      new NextRequest(`https://polycards.gg${path}`, {
        headers: { host: 'polycards.gg', ...headers },
      }),
    );

  it('matches the polled routes, and only them', () => {
    expect(matches('/api/pack-detail/bronze-pack')).toBe(true);
    expect(matches('/api/recent-pulls')).toBe(true);
    expect(matches('/api/pull-gaps')).toBe(true);
    expect(matches('/api/cards/charizard-4')).toBe(true);
    expect(matches('/api/free-pack')).toBe(true);
    expect(matches('/api/announcements')).toBe(true);
    expect(matches('/api/lucky-draw-status')).toBe(true);
    expect(matches('/api/pack-page/bronze-pack')).toBe(true);
    expect(matches('/api/pack-tiers/bronze-pack')).toBe(true);
    expect(matches('/api/me')).toBe(false);
    expect(matches('/api/presence')).toBe(false);
  });

  it("guards the homepage flow's tier view the same way", () => {
    expect(get('/api/pack-tiers/gold-pack')?.status).toBe(403);
    expect(
      get('/api/pack-tiers/gold-pack', {
        'sec-fetch-site': 'none',
        'sec-fetch-dest': 'document',
      })?.status,
    ).toBe(403);
    expect(
      get('/api/pack-tiers/gold-pack', {
        'sec-fetch-site': 'cross-site',
        referer: 'https://polycards.gg/',
      })?.status,
    ).toBe(403);
    expect(
      get('/api/pack-tiers/gold-pack', { 'sec-fetch-site': 'same-origin' }),
    ).toBeUndefined();
    expect(
      get('/api/pack-tiers/gold-pack', { referer: 'https://polycards.gg/' }),
    ).toBeUndefined();
  });

  it('guards the card, free-pack and announcement polls the same way', () => {
    expect(get('/api/cards/charizard-4')?.status).toBe(403);
    expect(get('/api/free-pack')?.status).toBe(403);
    expect(get('/api/announcements')?.status).toBe(403);
    expect(get('/api/lucky-draw-status')?.status).toBe(403);
    expect(
      get('/api/lucky-draw-status', { 'sec-fetch-site': 'same-origin' }),
    ).toBeUndefined();
    expect(
      get('/api/cards/charizard-4', { 'sec-fetch-site': 'same-origin' }),
    ).toBeUndefined();
  });

  it("guards the pack picker's in-place switch the same way", () => {
    expect(get('/api/pack-page/bronze-pack')?.status).toBe(403);
    expect(
      get('/api/pack-page/bronze-pack', {
        'sec-fetch-site': 'none',
        'sec-fetch-dest': 'document',
      })?.status,
    ).toBe(403);
    expect(
      get('/api/pack-page/bronze-pack', { 'sec-fetch-site': 'same-origin' }),
    ).toBeUndefined();
  });

  it("lets the page's own poll through (Fetch Metadata)", () => {
    expect(
      get('/api/pack-detail/bronze-pack', {
        'sec-fetch-site': 'same-origin',
        'sec-fetch-dest': 'empty',
      }),
    ).toBeUndefined();
  });

  it('lets older Safari through on a same-origin Referer alone', () => {
    expect(
      get('/api/recent-pulls', {
        referer: 'https://polycards.gg/slots/bronze-pack',
      }),
    ).toBeUndefined();
  });

  it('refuses the 2026-10-25 flood shape: a direct navigation with no Referer', () => {
    const res = get('/api/pack-detail/bronze-pack', {
      'sec-fetch-site': 'none',
      'sec-fetch-dest': 'document',
    });
    expect(res?.status).toBe(403);
    expect(res?.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses bare clients and cross-site callers, even with a spoofed Referer', () => {
    expect(get('/api/recent-pulls')?.status).toBe(403);
    expect(
      get('/api/pull-gaps', { referer: 'https://evil.example/x' })?.status,
    ).toBe(403);
    expect(
      get('/api/pack-detail/cr', {
        'sec-fetch-site': 'cross-site',
        referer: 'https://polycards.gg/slots/cr',
      })?.status,
    ).toBe(403);
  });
});

describe('card pages — a handle that cannot be a card never renders', () => {
  const get = (path: string) =>
    proxy(new NextRequest(`https://polycards.gg${path}`));

  it('matches /card/*', () => {
    expect(matches('/card/adasdsad')).toBe(true);
    expect(get('/cards')?.status).toBe(404); // not a route either
  });

  it('answers the 2026-10-25 flood handle with a bare, cacheable 404', async () => {
    const res = get('/card/adasdsad');
    expect(res?.status).toBe(404);
    expect(res?.headers.get('cache-control')).toBe('public, max-age=300');
    expect(get('/card/%E0%A4%A')?.status).toBe(404); // undecodable
    expect(get('/card/Pikachu-1')?.status).toBe(404); // uppercase is never a handle
  });

  it('passes a real handle (and its RSC fetch) through untouched', () => {
    expect(get('/card/pikachu-tg05-psa-10-4080757')).toBeUndefined();
    expect(
      get('/card/lugia-gx-100-psa-10-3468671?prize=weekly&_rsc=abc'),
    ).toBeUndefined();
  });
});

describe('origin lock — only requests forwarded by our Cloudflare zone', () => {
  const get = (path: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(`https://polycards.gg${path}`, { headers }));
  afterEach(() => vi.unstubAllEnvs());

  it('is off while EDGE_SHARED_SECRET is unset', () => {
    vi.stubEnv('EDGE_SHARED_SECRET', '');
    expect(get('/leaderboard')).toBeUndefined();
  });

  it('refuses a request without the edge header, or with a wrong one', () => {
    vi.stubEnv('EDGE_SHARED_SECRET', 's3cret-value');
    const attempts: Record<string, string>[] = [
      {},
      { 'x-polycards-edge': 'nope' },
      { 'x-polycards-edge': 's3cret-valu' },
    ];
    for (const headers of attempts) {
      const res = get('/leaderboard', headers);
      expect(res?.status).toBe(403);
      expect(res?.headers.get('cache-control')).toBe('no-store');
    }
    // Applies before every other rule, so junk paths and APIs are refused too.
    expect(get('/leaderboard/sda')?.status).toBe(403);
    expect(
      get('/api/recent-pulls', { 'sec-fetch-site': 'same-origin' })?.status,
    ).toBe(403);
  });

  it('serves a request carrying the right header, and always /healthz', () => {
    vi.stubEnv('EDGE_SHARED_SECRET', 's3cret-value');
    expect(
      get('/leaderboard', { 'x-polycards-edge': 's3cret-value' }),
    ).toBeUndefined();
    expect(get('/healthz')).toBeUndefined();
  });
});

describe("a pack's own address under the home preview switch", () => {
  const get = (
    path: string,
    headers: Record<string, string> = {},
    method = 'GET',
  ) =>
    proxy(new NextRequest(`https://polycards.gg${path}`, { headers, method }));
  afterEach(() => vi.unstubAllEnvs());

  it('switch off: every pack address passes through untouched, as before', () => {
    vi.stubEnv('HOME_PREVIEW', '');
    for (const p of [
      '/slots/151',
      '/slots/151/',
      '/slots/151?count=1',
      '/slots/151?count=',
      '/slots/151?stage=3d',
      '/slots',
      '/slots/151/spin',
    ]) {
      expect(get(p), p).toBeUndefined();
      expect(get(p, { rsc: '1' }), p).toBeUndefined();
    }
  });

  it('switch on: a document load of a bare pack address goes to the flow page before anything renders', () => {
    vi.stubEnv('HOME_PREVIEW', '1');
    const res = get('/slots/151?stage=3d');
    expect(res?.status).toBe(307);
    expect(res?.headers.get('location')).toBe(
      'https://polycards.gg/home-preview?stage=3d&focus=151',
    );
    expect(get('/slots/151/')?.headers.get('location')).toBe(
      'https://polycards.gg/home-preview?focus=151',
    );
    expect(get('/slots/a%20b')?.headers.get('location')).toBe(
      'https://polycards.gg/home-preview?focus=a+b',
    );
    expect(get('/slots/151', {}, 'HEAD')?.status).toBe(307);
  });

  it("switch on: the pack page's own links, moves inside the site and other paths are untouched", () => {
    vi.stubEnv('HOME_PREVIEW', '1');
    expect(get('/slots/151?count=1')).toBeUndefined();
    expect(get('/slots/151?count=')).toBeUndefined();
    expect(get('/slots/151', { rsc: '1' })).toBeUndefined();
    expect(get('/slots/151/spin')).toBeUndefined();
    expect(get('/slots')).toBeUndefined();
    expect(get('/slots/%E0%A4%A')).toBeUndefined(); // undecodable
    expect(get('/slots/151', {}, 'POST')).toBeUndefined();
  });
});
