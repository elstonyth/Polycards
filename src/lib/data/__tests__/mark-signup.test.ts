/**
 * markSignup (src/lib/data/customer.ts) — the cookie the Meta Pixel reports as
 * CompleteRegistration. A visitor who rejected analytics gets none: the banner
 * mirrors its answer into the CONSENT_KEY cookie, which is what this reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jar = new Map<string, string>();
const set = vi.fn(
  (name: string, value: string, _options?: Record<string, unknown>) =>
    jar.set(name, value),
);
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name) } : undefined,
    set,
  }),
}));
// customer.ts holds the SDK for its sdk.store.customer.* calls; none run here.
vi.mock('@/lib/medusa', () => ({ sdk: { store: { customer: {} } } }));

import { markSignup } from '@/lib/data/customer';
import { CONSENT_KEY } from '@/lib/consent';
import { SIGNUP_MARKER } from '@/lib/pixel';

beforeEach(() => {
  jar.clear();
  set.mockClear();
});

describe('markSignup', () => {
  // No consent cookie yet: the banner is unanswered, and the marker waits.
  it('leaves a script-readable, week-long marker holding the method', async () => {
    await markSignup('google');
    expect(set).toHaveBeenCalledWith(
      SIGNUP_MARKER,
      'google',
      expect.objectContaining({ path: '/', maxAge: 60 * 60 * 24 * 7 }),
    );
    expect(set.mock.calls[0]?.[2]).not.toHaveProperty('httpOnly', true);
  });

  it('marks a visitor who accepted', async () => {
    jar.set(CONSENT_KEY, 'accepted');
    await markSignup('email');
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('sets nothing for a visitor who rejected analytics', async () => {
    jar.set(CONSENT_KEY, 'rejected');
    await markSignup('email');
    expect(set).not.toHaveBeenCalled();
  });
});
