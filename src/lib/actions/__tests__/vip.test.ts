import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// The action imports the port's HTTP adapter; point that import at an
// in-memory backend per test (src/lib/__tests__/store-shim.ts). Nothing
// beneath the port (SDK, cookies, logger) is mocked — the real schema parsing
// and copy tables run.
vi.mock('@/lib/store', () => ({ store: storeShim }));

import { getVip } from '../vip';

const VIP = {
  level: 2,
  highest_level_ever: 3,
  spend: 500,
  next: { level: 3, threshold: 1000, remaining: 500, reward: {} },
  levels: [
    {
      level: 1,
      threshold: 0,
      reward: { voucher_amount: 0, frame_unlock: false },
    },
    {
      level: 2,
      threshold: 300,
      reward: { voucher_amount: 2, frame_unlock: true },
    },
  ],
};

describe('getVip', () => {
  it('reads /store/vip with the customer bearer and maps it to camelCase', async () => {
    const mem = backend({ 'GET /store/vip': { body: VIP } });
    expect(await getVip()).toEqual({
      ok: true,
      vip: {
        level: 2,
        highestLevelEver: 3,
        spend: 500,
        // `reward` rides the loose object and is deliberately dropped here —
        // nothing renders the teaser's copy of it (#523).
        next: { level: 3, threshold: 1000, remaining: 500 },
        levels: [
          {
            level: 1,
            threshold: 0,
            reward: { voucherAmount: 0, boxTier: '', frameUnlock: false },
          },
          {
            level: 2,
            threshold: 300,
            reward: { voucherAmount: 2, boxTier: '', frameUnlock: true },
          },
        ],
      },
    });
    expect(mem.requests).toEqual([
      {
        method: 'GET',
        path: '/store/vip',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
      },
    ]);
  });

  it('logged out: asks for a login without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await getVip()).toEqual({
      ok: false,
      error: 'Please log in to view your VIP status.',
      needsAuth: true,
    });
    expect(mem.requests).toEqual([]);
  });

  // The COPY still comes from the text rules; only `needsAuth` is decided by
  // the port's classification.
  it.each([
    [{ status: 401 }, 'Please log in to view your VIP status.', true],
    [
      { status: 429 },
      'Too many requests — give it a moment and try again.',
      false,
    ],
    [
      { status: 500, body: { message: 'boom' } },
      'Something went wrong. Please try again.',
      false,
    ],
  ])('backend answer %o → its copy', async (answer, error, needsAuth) => {
    backend({ 'GET /store/vip': answer });
    expect(await getVip()).toEqual({ ok: false, error, needsAuth });
  });

  it('a 2xx that fails VipSchema is an unexpected response, not a crash', async () => {
    backend({ 'GET /store/vip': { body: { level: 'gold' } } });
    expect(await getVip()).toEqual({
      ok: false,
      error: 'Got an unexpected response. Please try again.',
    });
  });
});
