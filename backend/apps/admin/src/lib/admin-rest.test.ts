import { afterEach, describe, expect, test, vi } from 'vitest';

// __BACKEND_URL__ is injected by the dashboard Vite plugin at build time and is
// only a `declare const` here, so it resolves to a global at runtime. Defining
// it lets the real fetch helpers run in the node test environment.
(globalThis as Record<string, unknown>).__BACKEND_URL__ = 'http://backend.test';

const { getPurchaseInvoice, httpStatus } = await import('./admin-rest');

const respondWith = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      body === undefined
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
    ),
  );

afterEach(() => vi.unstubAllGlobals());

// The whole chain the invoice detail page's "not found" copy rests on: the
// response status has to survive from fetch, through the thrown Error, out of
// httpStatus. Asserting httpStatus() on a hand-built object would prove only
// half of it and would still pass if the throw site stopped attaching status.
describe('failed admin-rest calls carry their HTTP status', () => {
  test('a real 404 is reported as 404', async () => {
    respondWith(404, { message: "Purchase invoice 'pinv_x' not found." });
    const err = await getPurchaseInvoice('pinv_x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(httpStatus(err)).toBe(404);
    expect((err as Error).message).toMatch(/not found/i);
  });

  test('a 500 is NOT reported as 404 — the bug this exists to stop', async () => {
    respondWith(500, { message: 'Internal server error' });
    const err = await getPurchaseInvoice('pinv_x').catch((e: unknown) => e);
    expect(httpStatus(err)).toBe(500);
    expect(httpStatus(err)).not.toBe(404);
  });

  test('an unrouted 404 with no JSON body still reports 404', async () => {
    // Task 4 established that an unrouted Medusa 404 carries NO message field,
    // so message-matching cannot distinguish these — only the status can.
    respondWith(404, undefined);
    const err = await getPurchaseInvoice('pinv_x').catch((e: unknown) => e);
    expect((err as Error).message).toBe('Request failed (404).');
    expect(httpStatus(err)).toBe(404);
  });

  test('a transport failure reports NO status, so it cannot read as 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const err = await getPurchaseInvoice('pinv_x').catch((e: unknown) => e);
    expect(httpStatus(err)).toBeUndefined();
  });
});

describe('httpStatus', () => {
  test('ignores anything that is not a numeric status', () => {
    expect(httpStatus(new Error('plain'))).toBeUndefined();
    expect(httpStatus(null)).toBeUndefined();
    expect(httpStatus(undefined)).toBeUndefined();
    expect(httpStatus('404')).toBeUndefined();
    expect(httpStatus({ status: '404' })).toBeUndefined();
  });
});
