/**
 * The referral cookie seam (src/lib/referral-cookie.ts): what a signup binds
 * with, and in which order — the code typed into the form wins, the /r/<code>
 * cookie is the fallback, and the cookie is cleared whatever happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

const mocks = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      mocks.jar.has(name) ? { name, value: mocks.jar.get(name) } : undefined,
    set: (name: string, value: string) => void mocks.jar.set(name, value),
    delete: (name: string) => void mocks.jar.delete(name),
  }),
}));
// The bind goes through the `Store` port; the referral COOKIE still comes from
// the jar above, which is the seam this file is really about.
vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  bindReferral,
  readReferralCookie,
  REFERRAL_COOKIE,
  setReferralCookie,
} from '@/lib/referral-cookie';

const BIND_ROUTE = 'POST /store/referral/bind';
/** A logged-in backend that accepts the bind, unless `opts` says otherwise. */
const bindBackend = (
  res: { status?: number; body?: unknown } = { body: {} },
  opts?: { token?: string | null },
) => backend({ [BIND_ROUTE]: res }, opts);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.jar.clear();
});

describe('readReferralCookie', () => {
  it('returns the planted code', async () => {
    await setReferralCookie('F42B0700');
    expect(await readReferralCookie()).toBe('F42B0700');
  });

  it('ignores a pre-code (handle-shaped) cookie instead of binding junk', async () => {
    mocks.jar.set(REFERRAL_COOKIE, 'dope-tcg-collectibles-ulbr');
    expect(await readReferralCookie()).toBeNull();
  });
});

describe('bindReferral — precedence and cleanup', () => {
  it('a code from the form wins over the cookie', async () => {
    mocks.jar.set(REFERRAL_COOKIE, 'AAAAAAAA');
    const mem = bindBackend();
    await bindReferral('F42B0700');

    expect(mem.requests).toEqual([
      {
        method: 'POST',
        path: '/store/referral/bind',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
        body: { referrer_code: 'F42B0700' },
      },
    ]);
  });

  it('falls back to the /r/<code> cookie when the form carried nothing', async () => {
    mocks.jar.set(REFERRAL_COOKIE, 'AAAAAAAA');
    const mem = bindBackend();
    await bindReferral();

    expect(mem.requests[0]?.body).toEqual({ referrer_code: 'AAAAAAAA' });
  });

  it('does nothing without a code or a cookie', async () => {
    const mem = bindBackend();
    await bindReferral();
    expect(mem.requests).toHaveLength(0);
  });

  it('clears the cookie whether the bind succeeded or failed', async () => {
    mocks.jar.set(REFERRAL_COOKIE, 'AAAAAAAA');
    bindBackend({ status: 500, body: { message: 'boom' } });
    await expect(bindReferral()).resolves.toBeUndefined();
    expect(mocks.jar.has(REFERRAL_COOKIE)).toBe(false);

    mocks.jar.set(REFERRAL_COOKIE, 'AAAAAAAA');
    bindBackend();
    await bindReferral('F42B0700');
    expect(mocks.jar.has(REFERRAL_COOKIE)).toBe(false);
  });

  it('never binds without a session token (nothing to attach the code to)', async () => {
    const mem = bindBackend({ body: {} }, { token: null });
    await bindReferral('F42B0700');
    expect(mem.requests).toHaveLength(0);
  });
});
