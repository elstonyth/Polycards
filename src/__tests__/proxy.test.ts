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
    expect(matches('/api/me')).toBe(false);
    expect(matches('/api/presence')).toBe(false);
  });

  it('guards the card, free-pack and announcement polls the same way', () => {
    expect(get('/api/cards/charizard-4')?.status).toBe(403);
    expect(get('/api/free-pack')?.status).toBe(403);
    expect(get('/api/announcements')?.status).toBe(403);
    expect(
      get('/api/cards/charizard-4', { 'sec-fetch-site': 'same-origin' }),
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
