/**
 * The referral cookie seam (src/lib/referral-cookie.ts): what a signup binds
 * with, and in which order — the code typed into the form wins, the /r/<code>
 * cookie is the fallback, and the cookie is cleared whatever happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  authedFetch: vi.fn(async (..._args: unknown[]) => ({})),
  getAuthToken: vi.fn(async (): Promise<string | undefined> => 'jwt'),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      mocks.jar.has(name) ? { name, value: mocks.jar.get(name) } : undefined,
    set: (name: string, value: string) => void mocks.jar.set(name, value),
    delete: (name: string) => void mocks.jar.delete(name),
  }),
}));
vi.mock('@/lib/authed-fetch', () => ({ authedFetch: mocks.authedFetch }));
vi.mock('@/lib/data/customer', () => ({ getAuthToken: mocks.getAuthToken }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  bindReferral,
  readReferralCookie,
  REFERRAL_COOKIE,
  setReferralCookie,
} from '@/lib/referral-cookie';

const bindBody = () =>
  (mocks.authedFetch.mock.calls[0] as unknown[])?.[2] as
    { body?: { referrer_code?: string } } | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.jar.clear();
  mocks.getAuthToken.mockResolvedValue('jwt');
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
    await bindReferral('F42B0700');

    expect(mocks.authedFetch).toHaveBeenCalledTimes(1);
    expect(mocks.authedFetch.mock.calls[0]![1]).toBe('/store/referral/bind');
    expect(bindBody()?.body).toEqual({ referrer_code: 'F42B0700' });
  });

  it('falls back to the /r/<code> cookie when the form carried nothing', async () => {
    mocks.jar.set(REFERRAL_COOKIE, 'AAAAAAAA');
    await bindReferral();

    expect(bindBody()?.body).toEqual({ referrer_code: 'AAAAAAAA' });
  });

  it('does nothing without a code or a cookie', async () => {
    await bindReferral();
    expect(mocks.authedFetch).not.toHaveBeenCalled();
  });

  it('clears the cookie whether the bind succeeded or failed', async () => {
    mocks.jar.set(REFERRAL_COOKIE, 'AAAAAAAA');
    mocks.authedFetch.mockRejectedValueOnce(new Error('boom'));
    await expect(bindReferral()).resolves.toBeUndefined();
    expect(mocks.jar.has(REFERRAL_COOKIE)).toBe(false);

    mocks.jar.set(REFERRAL_COOKIE, 'AAAAAAAA');
    await bindReferral('F42B0700');
    expect(mocks.jar.has(REFERRAL_COOKIE)).toBe(false);
  });

  it('never binds without a session token (nothing to attach the code to)', async () => {
    mocks.getAuthToken.mockResolvedValue(undefined);
    await bindReferral('F42B0700');
    expect(mocks.authedFetch).not.toHaveBeenCalled();
  });
});
