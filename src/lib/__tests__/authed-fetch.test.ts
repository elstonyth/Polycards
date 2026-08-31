/**
 * The authenticated-call seam (src/lib/authed-fetch.ts) plus the status probes
 * it exists to make possible (httpStatus / isAuthError in src/lib/errors.ts).
 *
 * `sdk` is mocked the same way every data/action test mocks it, so these
 * assertions pin exactly what reaches the wire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from '@medusajs/js-sdk';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/medusa', () => ({ sdk: { client: { fetch: fetchMock } } }));

import { authedFetch } from '@/lib/authed-fetch';
import { httpStatus, isAuthError } from '@/lib/errors';

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({});
});

/** The options object handed to sdk.client.fetch on the first (only) call. */
const optsOf = () =>
  fetchMock.mock.calls[0]![1] as {
    headers?: Record<string, string>;
    cache?: string;
    method?: string;
    body?: unknown;
    query?: unknown;
  };

describe('authedFetch', () => {
  it('attaches the bearer and no-store when a token is present', async () => {
    await authedFetch('tok', '/store/vault');
    expect(fetchMock).toHaveBeenCalledWith('/store/vault', {
      headers: { Authorization: 'Bearer tok' },
      cache: 'no-store',
    });
  });

  // The regression this guards: interpolating an absent token would send the
  // literal header `Bearer undefined`, which the backend rejects — silently
  // turning /store/free-pack's guest answer (the signup promo) into a failure.
  it('omits the header entirely — never `Bearer undefined` — with no token', async () => {
    await authedFetch(undefined, '/store/free-pack');
    expect(optsOf().headers).toEqual({});
    expect(JSON.stringify(optsOf())).not.toContain('undefined');
  });

  it('keeps the caller’s method, body, query and extra headers', async () => {
    await authedFetch('tok', '/store/credits/withdraw', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'attempt-1' },
      body: { amount: 50 },
      query: { limit: 20 },
    });
    expect(optsOf()).toEqual({
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Idempotency-Key': 'attempt-1' },
      cache: 'no-store',
      body: { amount: 50 },
      query: { limit: 20 },
    });
  });

  it('lets the caller override the cache mode', async () => {
    await authedFetch('tok', '/store/vault', { cache: 'force-cache' });
    expect(optsOf().cache).toBe('force-cache');
  });

  // src/lib/ttl-cache.ts's `cached()` evicts a REJECTED promise and memoises a
  // resolved one, so a loader that swallows its own failure poisons the cache
  // for the whole window. authedFetch must therefore be transparent to failure
  // — it may never catch, and may never resolve to a degraded value.
  it('rejects rather than swallowing, so a cached() loader still throws', async () => {
    const boom = new FetchError('backend down', 'Bad Gateway', 502);
    fetchMock.mockRejectedValueOnce(boom);
    await expect(authedFetch('tok', '/store/vault')).rejects.toBe(boom);
  });
});

describe('httpStatus / isAuthError', () => {
  it('reads the status off a FetchError instead of its message', () => {
    expect(httpStatus(new FetchError('nope', 'Not Found', 404))).toBe(404);
    expect(httpStatus(new FetchError('nope', 'Gone', 410))).toBe(410);
  });

  it('is undefined when the failure never carried a status', () => {
    expect(httpStatus(new Error('socket hang up'))).toBeUndefined();
    expect(httpStatus('not even an error')).toBeUndefined();
  });

  // The point of the refactor: a 401 whose prose says nothing about auth used
  // to read as a non-auth failure, so the UI showed a generic error instead of
  // reopening the login sheet.
  it('treats a 401 as an auth error however the body is worded', () => {
    expect(
      isAuthError(new FetchError('Invalid token.', 'Unauthorized', 401)),
    ).toBe(true);
  });

  it('still catches an auth failure that carries no status (superset of the old text probe)', () => {
    expect(isAuthError(new Error('Not authenticated.'))).toBe(true);
    expect(isAuthError(new Error('unauthorized'))).toBe(true);
  });

  it('does not claim an auth error for an unrelated status or message', () => {
    expect(
      isAuthError(new FetchError('Not enough credits', 'Bad Request', 400)),
    ).toBe(false);
    expect(isAuthError(new Error('socket hang up'))).toBe(false);
  });
});
