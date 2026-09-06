/**
 * The `Store` port's HTTP adapter (src/lib/store.ts) — the ONE place the
 * storefront builds a request to the Medusa backend. Everything beneath it
 * (the cookie jar, the SDK client, the logger) is mocked here and nowhere
 * else: every other test seeds `memoryStore` (src/lib/store-memory.ts).
 *
 * The header / cache pins moved here from authed-fetch.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from '@medusajs/js-sdk';

const mocks = vi.hoisted(() => ({
  cookieValue: undefined as string | undefined,
  cookies: vi.fn(),
  fetch: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('@/lib/medusa', () => ({ sdk: { client: { fetch: mocks.fetch } } }));
vi.mock('@/lib/logger', () => ({
  logger: { error: mocks.logError, warn: vi.fn() },
}));

import { store } from '@/lib/store';
import { StoreError, type Failure } from '@/lib/store-port';
import { BalanceSchema } from '@/lib/data/schemas';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieValue = 'tok';
  mocks.cookies.mockImplementation(async () => ({
    // The cookie name is the contract with data/customer.ts's setter.
    get: (name: string) =>
      name === '_polycards_jwt' && mocks.cookieValue !== undefined
        ? { value: mocks.cookieValue }
        : undefined,
  }));
  mocks.fetch.mockResolvedValue({ balance: 12 });
});

const GET_INIT = {
  method: 'GET',
  headers: { Authorization: 'Bearer tok' },
  cache: 'no-store',
};

describe('store — auth', () => {
  it('auth required (the default) with no cookie: unauthenticated, no network hop, no log line', async () => {
    mocks.cookieValue = undefined;
    const r = await store.get('/store/vault', BalanceSchema);
    expect(r).toEqual({
      ok: false,
      kind: 'unauthenticated',
      text: 'Not authenticated.',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  // The regression this guards: interpolating an absent token would send the
  // literal header `Bearer undefined`, which the backend rejects — silently
  // turning /store/free-pack's guest answer (the signup promo) into a failure.
  it('auth optional with no cookie: the call goes out with no Authorization header — never `Bearer undefined`', async () => {
    mocks.cookieValue = undefined;
    const r = await store.get('/store/free-pack', BalanceSchema, {
      auth: 'optional',
    });
    expect(r).toEqual({ ok: true, data: { balance: 12 } });
    expect(mocks.fetch).toHaveBeenCalledWith('/store/free-pack', {
      ...GET_INIT,
      headers: {},
    });
    expect(JSON.stringify(mocks.fetch.mock.calls[0])).not.toContain(
      'undefined',
    );
  });

  it('auth none: never opens the cookie jar (reading it would make a public route dynamic)', async () => {
    await store.get('/store/payments/config', BalanceSchema, { auth: 'none' });
    expect(mocks.cookies).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith('/store/payments/config', {
      ...GET_INIT,
      headers: {},
    });
  });
});

describe('store — what reaches the wire', () => {
  it('GET: the cookie bearer and no-store, nothing else', async () => {
    await store.get('/store/vault', BalanceSchema);
    expect(mocks.fetch).toHaveBeenCalledWith('/store/vault', GET_INIT);
  });

  it('POST: method, body, query and the Idempotency-Key beside the bearer', async () => {
    await store.post(
      '/store/credits/withdraw',
      BalanceSchema,
      { amount: 50 },
      { idempotencyKey: 'attempt-1', query: { limit: 20 } },
    );
    expect(mocks.fetch).toHaveBeenCalledWith('/store/credits/withdraw', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Idempotency-Key': 'attempt-1' },
      cache: 'no-store',
      body: { amount: 50 },
      query: { limit: 20 },
    });
  });

  it('DELETE carries a body (the saved-accounts route takes the id there)', async () => {
    await store.del('/store/credits/withdraw/accounts', BalanceSchema, {
      id: 'acct_1',
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      '/store/credits/withdraw/accounts',
      {
        ...GET_INIT,
        method: 'DELETE',
        body: { id: 'acct_1' },
      },
    );
  });

  it('lets the caller pick force-cache', async () => {
    await store.get('/store/vault', BalanceSchema, { cache: 'force-cache' });
    expect(mocks.fetch).toHaveBeenCalledWith('/store/vault', {
      ...GET_INIT,
      cache: 'force-cache',
    });
  });
});

describe('store — classification (never throws)', () => {
  it('a 2xx that fits the schema is ok with the parsed data', async () => {
    expect(await store.get('/store/credits/balance', BalanceSchema)).toEqual({
      ok: true,
      data: { balance: 12 },
    });
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('a 2xx that fails the schema is invalid_shape — never null data — and is logged once', async () => {
    mocks.fetch.mockResolvedValueOnce({ balance: 'lots' });
    const r = await store.get('/store/credits/balance', BalanceSchema);
    expect(r).toMatchObject({ ok: false, kind: 'invalid_shape' });
    expect((r as Failure).text).toEqual(expect.any(String));
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'unauthenticated'],
    [429, 'rate_limited'],
    [404, 'not_found'],
    [400, 'backend'],
    [500, 'backend'],
  ] as const)(
    '%s → %s, surfacing the status and the backend text',
    async (status, kind) => {
      mocks.fetch.mockRejectedValueOnce(
        new FetchError('Invalid token.', 'Whatever', status),
      );
      expect(await store.get('/store/vault', BalanceSchema)).toEqual({
        ok: false,
        kind,
        status,
        text: 'Invalid token.',
      });
    },
  );

  it('a failure that never reached a response is backend with no status', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await store.get('/store/vault', BalanceSchema);
    expect(r).toEqual({ ok: false, kind: 'backend', text: 'socket hang up' });
    expect((r as Failure).status).toBeUndefined();
  });

  // Regression: the caught error (and, for undici, its nested `.cause` — e.g.
  // `ECONNREFUSED`/`ENOTFOUND`/TLS detail on a `TypeError: fetch failed`) must
  // still reach the log line, not just the `{ kind, status, text }` triple —
  // that's what prod triage of a "fetch failed" report needs.
  it('logs the original error (not just kind/status/text) on a network failure', async () => {
    const netError = new TypeError('fetch failed');
    (netError as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
    mocks.fetch.mockRejectedValueOnce(netError);
    const r = await store.get('/store/vault', BalanceSchema);
    expect(r).toEqual({ ok: false, kind: 'backend', text: 'fetch failed' }); // public Failure unchanged
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0]?.[2]).toBe(netError);
    expect(
      (
        (mocks.logError.mock.calls[0]?.[2] as { cause?: unknown }).cause as {
          code?: string;
        }
      ).code,
    ).toBe('ECONNREFUSED');
  });

  it('a non-Error rejection still resolves', async () => {
    mocks.fetch.mockRejectedValueOnce('boom');
    expect(await store.get('/store/vault', BalanceSchema)).toEqual({
      ok: false,
      kind: 'backend',
      text: 'boom',
    });
  });

  it('logs each failure exactly once, naming the call', async () => {
    mocks.fetch.mockRejectedValueOnce(
      new FetchError('down', 'Bad Gateway', 502),
    );
    await store.get('/store/vault', BalanceSchema);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0]?.[0]).toContain('GET /store/vault');
  });
});

describe('store.orThrow', () => {
  it('unwraps a success', () => {
    expect(store.orThrow({ ok: true, data: 1 })).toBe(1);
  });

  // src/lib/ttl-cache.ts's `cached()` evicts a REJECTED promise and memoises a
  // resolved one, so a loader must throw on failure rather than resolve to a
  // degraded value.
  it('throws a StoreError carrying the failure, so a cached() loader still rejects', () => {
    const failure: Failure = {
      ok: false,
      kind: 'backend',
      status: 502,
      text: 'down',
    };
    let thrown: unknown;
    try {
      store.orThrow(failure);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(StoreError);
    expect((thrown as StoreError).failure).toBe(failure);
    expect((thrown as StoreError).message).toBe('down');
  });
});
