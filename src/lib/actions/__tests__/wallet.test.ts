import { describe, it, expect, vi } from 'vitest';
import { memoryStore, type MemoryRoutes } from '@/lib/store-memory';
import type { Store } from '@/lib/store';

// The action imports the port's HTTP adapter; point that import at an
// in-memory backend per test. Nothing beneath the port is mocked.
const port = vi.hoisted(() => ({ current: undefined as unknown as Store }));
vi.mock('@/lib/store', () => {
  const shim: Store = {
    get: (path, schema, o) => port.current.get(path, schema, o),
    post: (path, schema, body, o) => port.current.post(path, schema, body, o),
    del: (path, schema, body, o) => port.current.del(path, schema, body, o),
    orThrow: (r) => port.current.orThrow(r),
  };
  return { store: shim };
});

import { getWallet } from '../wallet';

function backend(routes: MemoryRoutes, opts?: { token?: string | null }) {
  port.current = memoryStore(routes, opts);
  return port.current as ReturnType<typeof memoryStore>;
}

const WALLET = {
  balance: 120,
  available: 100,
  is_frozen: false,
  withdrawable: 40,
  playthrough: { deposited: 200, used: 160, remaining: 40 },
};

describe('getWallet', () => {
  it('reads the wallet block with the customer bearer', async () => {
    const mem = backend({
      'GET /store/credits': { body: { wallet: WALLET, transactions: [] } },
    });
    expect(await getWallet()).toEqual({
      ok: true,
      wallet: {
        balance: 120,
        available: 100,
        isFrozen: false,
        withdrawable: 40,
        playthrough: { deposited: 200, used: 160, remaining: 40 },
      },
    });
    expect(mem.requests).toEqual([
      {
        method: 'GET',
        path: '/store/credits',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
      },
    ]);
  });

  it('deploy skew: a backend without the playthrough fields reads as not-yet-withdrawable', async () => {
    const { withdrawable: _w, playthrough: _p, ...legacy } = WALLET;
    backend({ 'GET /store/credits': { body: { wallet: legacy } } });
    const r = await getWallet();
    expect(r.ok && r.wallet.withdrawable).toBe(0);
    expect(r.ok && r.wallet.playthrough).toEqual({
      deposited: 0,
      used: 0,
      remaining: 0,
    });
  });

  it('logged out: asks for a login without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await getWallet()).toEqual({
      ok: false,
      error: 'Please log in to view your wallet.',
      needsAuth: true,
    });
    expect(mem.requests).toEqual([]);
  });

  // The COPY still comes from the text rules (a 401 whose body says nothing
  // about auth reads as the generic fallback, as it always has); only
  // `needsAuth` is decided by the port's classification.
  it.each([
    [{ status: 401 }, 'Please log in to view your wallet.', true],
    [
      { status: 401, body: { message: 'Invalid token.' } },
      'Something went wrong. Please try again.',
      true,
    ],
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
    backend({ 'GET /store/credits': answer });
    expect(await getWallet()).toEqual({ ok: false, error, needsAuth });
  });

  it('a 2xx without a valid wallet block is an unexpected response, not a crash', async () => {
    backend({
      'GET /store/credits': { body: { wallet: { balance: 'lots' } } },
    });
    expect(await getWallet()).toEqual({
      ok: false,
      error: 'Got an unexpected response. Please try again.',
    });
  });
});
