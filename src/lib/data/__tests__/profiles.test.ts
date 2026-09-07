import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// getPublicProfile's job is to distinguish WHY it returned no profile so the
// page can branch: a 404 (unknown/legacy handle) → a real 404 page, but any
// transient failure (5xx, network, schema-invalid) → error state, never a
// fake persona — and a 410 → 'unavailable', because a disabled account's
// handle is still TAKEN. profiles.ts imports 'server-only' (throws outside an
// RSC) at module load — stub it. The loaders read through the Store port, so
// an in-memory backend seeds them and the real PublicProfileSchema /
// ProfileHandleSchema run.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/store', () => ({ store: storeShim }));

import {
  getPublicProfile,
  fetchProfileHandle,
  getOwnProfileHandle,
} from '@/lib/data/profiles';

const PROFILE_ROUTE = 'GET /store/profiles/:handle';
const ME_ROUTE = 'GET /store/profiles/me';

// A minimal valid PublicProfile that passes PublicProfileSchema.
const validProfile = {
  handle: 'ace',
  name: 'Ace',
  seed: 1,
  joined_at: '2026-01-01T00:00:00Z',
  stats: {
    pulls: 3,
    volume: 100,
    by_rarity: {
      Immortal: 0,
      Legendary: 0,
      Mythical: 0,
      Rare: 1,
      Uncommon: 1,
      Common: 1,
    },
  },
  recent: [],
};

describe('getPublicProfile', () => {
  it('reads the public profile route with no bearer and no cache key', async () => {
    const mem = backend({ [PROFILE_ROUTE]: { body: validProfile } });
    await getPublicProfile('ace-wire');
    expect(mem.requests[0]).toEqual({
      method: 'GET',
      path: '/store/profiles/ace-wire',
      headers: {},
      cache: 'auto',
    });
  });

  it('returns { status: "ok", profile } for a valid response', async () => {
    backend({ [PROFILE_ROUTE]: { body: validProfile } });
    const res = await getPublicProfile('ace');
    expect(res).toEqual({ status: 'ok', profile: validProfile });
  });

  it('returns { status: "notfound" } on a 404 (unknown/legacy handle → mock)', async () => {
    backend({ [PROFILE_ROUTE]: { status: 404, body: { message: 'nope' } } });
    const res = await getPublicProfile('nobody-404');
    expect(res).toEqual({ status: 'notfound' });
  });

  // A disabled account's handle is REAL, so folding 410 into notfound would
  // hand it the mock persona — a fabricated collector published exactly where
  // an operator asked for the profile to disappear.
  it('returns { status: "unavailable" } on a 410 (disabled account → NOT mock)', async () => {
    backend({ [PROFILE_ROUTE]: { status: 410, body: { message: 'gone' } } });
    const res = await getPublicProfile('nobody-410');
    expect(res).toEqual({ status: 'unavailable' });
  });

  it('returns { status: "error" } on a non-404 throw (outage → NOT mock)', async () => {
    backend({ [PROFILE_ROUTE]: { status: 500, body: { message: 'boom' } } });
    const res = await getPublicProfile('ace-500');
    expect(res).toEqual({ status: 'error' });
  });

  // Pre-port this case was a status-less throw (a bare ECONNREFUSED Error).
  // The port classifies on status alone, so a network drop and a bodyless 5xx
  // are the same non-404 failure here; the status-less variant itself is
  // pinned in store.test.ts.
  it('returns { status: "error" } for a failure carrying no message either', async () => {
    backend({ [PROFILE_ROUTE]: { status: 502 } });
    const res = await getPublicProfile('ace-net');
    expect(res).toEqual({ status: 'error' });
  });

  it('returns { status: "error" } on a schema-invalid response (NOT notfound)', async () => {
    // missing stats/recent/etc
    backend({ [PROFILE_ROUTE]: { body: { handle: 'ace', name: 'Ace' } } });
    const res = await getPublicProfile('ace-bad');
    expect(res).toEqual({ status: 'error' });
  });
});

describe('the own-handle reads', () => {
  // fetchProfileHandle runs in the same request that SETS the auth cookie
  // (login, Google callback), so the jar still holds the pre-login value —
  // it must send the token it was handed, not whatever the jar has.
  it('fetchProfileHandle sends the given bearer, not the cookie', async () => {
    const mem = backend(
      { [ME_ROUTE]: { body: { handle: 'ash-1234' } } },
      { token: 'cookie-token' },
    );
    expect(await fetchProfileHandle('fresh-token')).toBe('ash-1234');
    expect(mem.requests[0]).toEqual({
      method: 'GET',
      path: '/store/profiles/me',
      headers: { Authorization: 'Bearer fresh-token' },
      cache: 'no-store',
    });
  });

  it('getOwnProfileHandle reads the cookie bearer', async () => {
    const mem = backend({ [ME_ROUTE]: { body: { handle: 'ash-1234' } } });
    expect(await getOwnProfileHandle()).toBe('ash-1234');
    expect(mem.requests[0]?.headers).toEqual({
      Authorization: 'Bearer test-token',
    });
  });

  it('is null when logged out, without leaving the storefront', async () => {
    const mem = backend(
      { [ME_ROUTE]: { body: { handle: 'x' } } },
      { token: null },
    );
    expect(await getOwnProfileHandle()).toBeNull();
    expect(mem.requests).toHaveLength(0);
  });

  it('is null on a backend failure and on a malformed 200', async () => {
    backend({ [ME_ROUTE]: { status: 500, body: {} } });
    expect(await getOwnProfileHandle()).toBeNull();
    backend({ [ME_ROUTE]: { body: { handle: 7 } } });
    expect(await fetchProfileHandle('t')).toBeNull();
  });
});
