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
