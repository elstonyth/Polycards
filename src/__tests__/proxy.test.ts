import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config, proxy } from '@/proxy';

const FORM = 'application/x-www-form-urlencoded';
const matches = (url: string, headers: Record<string, string> = {}) =>
  unstable_doesMiddlewareMatch({ config, url, headers });

describe('proxy matcher — runs only for the costly request shape', () => {
  it('matches a form-encoded request to / without Next-Action', () => {
    expect(matches('/', { 'content-type': FORM })).toBe(true);
  });

  it('skips real server actions, which carry Next-Action', () => {
    expect(
      matches('/', { 'content-type': FORM, 'next-action': 'abc123' }),
    ).toBe(false);
  });

  it('skips ordinary traffic and other content types', () => {
    expect(matches('/')).toBe(false);
    expect(
      matches('/', { 'content-type': 'multipart/form-data; boundary=x' }),
    ).toBe(false);
    expect(matches('/', { 'content-type': 'text/plain;charset=UTF-8' })).toBe(
      false,
    );
  });

  it('matches the content type exactly, as Next does', () => {
    // `has` values are anchored (^…$). Next only treats the bare type as a
    // possible action; with a charset it answers 405 itself, without a render.
    expect(matches('/', { 'content-type': `${FORM}; charset=UTF-8` })).toBe(
      false,
    );
  });

  it('never touches other pages (a gateway may POST a form to /transactions)', () => {
    expect(matches('/transactions', { 'content-type': FORM })).toBe(false);
    expect(matches('/slots/bronze-pack', { 'content-type': FORM })).toBe(false);
  });
});

describe('proxy handler', () => {
  it('answers a POST with 405 before anything renders', () => {
    const res = proxy(
      new NextRequest('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': FORM },
        body: 'a=1',
      }),
    );
    expect(res?.status).toBe(405);
    expect(res?.headers.get('allow')).toBe('GET, HEAD');
  });

  it('lets anything else through untouched', () => {
    expect(
      proxy(
        new NextRequest('http://localhost/', {
          headers: { 'content-type': FORM },
        }),
      ),
    ).toBeUndefined();
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
