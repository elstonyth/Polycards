import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from '@medusajs/js-sdk';

// getPublicProfile's job is to distinguish WHY it returned no profile so the
// page can branch: a 404 (unknown/legacy handle) → mock pool, but any transient
// failure (5xx, network, schema-invalid) → error state, never a fake persona.
// profiles.ts imports 'server-only' (throws outside an RSC) and @/lib/data/customer
// (touches next/headers) at module load — stub both. sdk + logger are mocked;
// the real parseOne/PublicProfileSchema run so schema validation is genuine.
vi.mock('server-only', () => ({}));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('@/lib/medusa', () => ({ sdk: { client: { fetch: fetchMock } } }));
vi.mock('@/lib/data/customer', () => ({ getAuthToken: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getPublicProfile } from '@/lib/data/profiles';

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

beforeEach(() => {
  fetchMock.mockReset();
});

describe('getPublicProfile', () => {
  it('returns { status: "ok", profile } for a valid response', async () => {
    fetchMock.mockResolvedValue(validProfile);
    const res = await getPublicProfile('ace');
    expect(res).toEqual({ status: 'ok', profile: validProfile });
  });

  it('returns { status: "notfound" } on a 404 (unknown/legacy handle → mock)', async () => {
    fetchMock.mockRejectedValue(new FetchError('nope', 'Not Found', 404));
    const res = await getPublicProfile('nobody-404');
    expect(res).toEqual({ status: 'notfound' });
  });

  // A disabled account's handle is REAL, so folding 410 into notfound would
  // hand it the mock persona — a fabricated collector published exactly where
  // an operator asked for the profile to disappear.
  it('returns { status: "unavailable" } on a 410 (disabled account → NOT mock)', async () => {
    fetchMock.mockRejectedValue(new FetchError('gone', 'Gone', 410));
    const res = await getPublicProfile('nobody-410');
    expect(res).toEqual({ status: 'unavailable' });
  });

  it('returns { status: "error" } on a non-404 throw (outage → NOT mock)', async () => {
    fetchMock.mockRejectedValue(new FetchError('boom', 'Server Error', 500));
    const res = await getPublicProfile('ace-500');
    expect(res).toEqual({ status: 'error' });
  });

  it('returns { status: "error" } on a network-style throw', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await getPublicProfile('ace-net');
    expect(res).toEqual({ status: 'error' });
  });

  it('returns { status: "error" } on a schema-invalid response (NOT notfound)', async () => {
    fetchMock.mockResolvedValue({ handle: 'ace', name: 'Ace' }); // missing stats/recent/etc
    const res = await getPublicProfile('ace-bad');
    expect(res).toEqual({ status: 'error' });
  });
});
