/**
 * The leaderboard seam's two calls, through the `Store` port.
 *
 * The board is PUBLIC and the own-standing read is per-customer, and the two
 * must not drift into each other: a bearer on the board would make it
 * per-visitor, and a missing one on /me would answer for nobody. Both are
 * pinned on the recorded request here.
 *
 * The cache CONTRACT (what may be memoised) lives in cache-contract.test.ts;
 * this file is the mapping and the wire shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getLeaderboard, getOwnWeekly } from '@/lib/data/leaderboard';
import { clearTtlCache } from '@/lib/ttl-cache';

const row = (over: Record<string, unknown> = {}) => ({
  name: 'Ash',
  points: 10,
  volume: 8173.26,
  pulls: 4,
  seed: 7,
  handle: 'ash-1234',
  ...over,
});

beforeEach(() => {
  // The board memoises per period for 30s — without this the first case's
  // rows would be served to every later one.
  clearTtlCache();
});

describe('getLeaderboard', () => {
  it('sends period as a query param, with no bearer and no cache key', async () => {
    // Pre-port this was `/store/leaderboard?period=weekly` with the query
    // pre-baked into the path; the SDK serializes the option to the same URL.
    // No Authorization (a public board) and no cache key (an explicit
    // no-store would make a prerenderable caller dynamic — the home page
    // renders this board).
    const mem = backend({
      'GET /store/leaderboard': { body: { entries: [] } },
    });
    await getLeaderboard('alltime');
    expect(mem.requests[0]).toEqual({
      method: 'GET',
      path: '/store/leaderboard',
      headers: {},
      cache: 'auto',
      query: { period: 'alltime' },
    });
  });

  it('maps rows to the standings shape and enriches the equipped frame', async () => {
    backend({
      'GET /store/leaderboard': {
        body: {
          entries: [
            row({ equipped_frame_level: 20 }),
            row({ name: 'Misty', volume: 12, pulls: 1, seed: 8, handle: null }),
          ],
        },
      },
    });
    const board = await getLeaderboard('weekly', { '20': '/frame-20.webp' });
    expect(board[0]).toMatchObject({
      rank: 1,
      name: 'Ash',
      handle: 'ash-1234',
      volume: 'RM 8,173.26',
      volumeMyr: 8173.26,
      pulls: '4',
      seed: 7,
      frame: '/frame-20.webp',
    });
    // No equipped frame → null, never a guessed one.
    expect(board[1]).toMatchObject({ rank: 2, handle: null, frame: null });
  });

  it('drops one malformed row and keeps the survivors', async () => {
    backend({
      'GET /store/leaderboard': {
        body: { entries: [row(), { name: 'Broken' }, row({ seed: 9 })] },
      },
    });
    expect(await getLeaderboard('weekly')).toHaveLength(2);
  });

  it('returns [] (never fake rows) when the backend fails', async () => {
    backend({ 'GET /store/leaderboard': { status: 500, body: {} } });
    expect(await getLeaderboard('weekly')).toEqual([]);
  });
});

describe('getOwnWeekly', () => {
  it('reads /store/leaderboard/me with the customer bearer', async () => {
    const mem = backend({
      'GET /store/leaderboard/me': {
        body: { volume: 420.5, pulls: 3, seed: 7 },
      },
    });
    expect(await getOwnWeekly()).toEqual({
      volumeMyr: 420.5,
      pulls: 3,
      seed: 7,
    });
    expect(mem.requests[0]).toEqual({
      method: 'GET',
      path: '/store/leaderboard/me',
      headers: { Authorization: 'Bearer test-token' },
      cache: 'no-store',
    });
  });

  it('is null for a logged-out visitor, and never leaves the storefront', async () => {
    const mem = backend(
      { 'GET /store/leaderboard/me': { body: {} } },
      {
        token: null,
      },
    );
    expect(await getOwnWeekly()).toBeNull();
    expect(mem.requests).toHaveLength(0);
  });

  it('is null on a backend failure and on a malformed 200 — the card falls back', async () => {
    backend({ 'GET /store/leaderboard/me': { status: 500, body: {} } });
    expect(await getOwnWeekly()).toBeNull();
    backend({ 'GET /store/leaderboard/me': { body: { volume: 'nope' } } });
    expect(await getOwnWeekly()).toBeNull();
  });
});
