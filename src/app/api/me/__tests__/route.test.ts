import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from '@medusajs/js-sdk';

// customer.ts imports 'server-only' (throws outside an RSC) and next/headers;
// the cookie store is a plain stub so the reaping can be observed directly.
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  cookieDelete: vi.fn(),
  retrieve: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: mocks.cookieGet,
    delete: mocks.cookieDelete,
    set: vi.fn(),
  }),
}));
vi.mock('@/lib/medusa', () => ({
  sdk: { store: { customer: { retrieve: mocks.retrieve } } },
}));
vi.mock('@/lib/data/profiles', () => ({
  getOwnProfileHandle: vi.fn(async () => 'handle'),
}));

import { GET } from '@/app/api/me/route';

const withToken = () => mocks.cookieGet.mockReturnValue({ value: 'stale-jwt' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieGet.mockReturnValue(undefined);
});

describe('GET /api/me — reaps a cookie the backend rejected outright', () => {
  it('token present + 401 → customer:null AND the cookie is cleared', async () => {
    withToken();
    mocks.retrieve.mockRejectedValueOnce(
      new FetchError('Unauthorized', 'Unauthorized', 401),
    );

    const res = await GET();

    expect(await res.json()).toEqual({ customer: null });
    expect(mocks.cookieDelete).toHaveBeenCalledWith('_polycards_jwt');
  });

  it('token present + 5xx → customer:null but the cookie SURVIVES the blip', async () => {
    withToken();
    mocks.retrieve.mockRejectedValueOnce(
      new FetchError('Bad Gateway', 'Bad Gateway', 502),
    );

    const res = await GET();

    expect(await res.json()).toEqual({ customer: null });
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });

  it('token present + network drop (no status) → cookie survives', async () => {
    withToken();
    mocks.retrieve.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await GET();

    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });

  it('no token → no backend call, nothing to clear', async () => {
    await GET();

    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });
});
