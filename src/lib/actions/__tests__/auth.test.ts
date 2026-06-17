import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real data modules import 'server-only' (throws outside an RSC) and touch
// next/headers — mock them wholesale so only the action logic under test runs.
const mocks = vi.hoisted(() => ({
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
  fetchProfileHandle: vi.fn(),
  clientFetch: vi.fn(),
  customerRetrieve: vi.fn(),
  customerCreate: vi.fn(),
}));

vi.mock('@/lib/data/customer', () => ({
  setAuthToken: mocks.setAuthToken,
  clearAuthToken: mocks.clearAuthToken,
  getAuthToken: vi.fn(),
}));
vi.mock('@/lib/data/profiles', () => ({
  fetchProfileHandle: mocks.fetchProfileHandle,
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/medusa', () => ({
  sdk: {
    client: { fetch: mocks.clientFetch },
    store: {
      customer: {
        retrieve: mocks.customerRetrieve,
        create: mocks.customerCreate,
      },
    },
    auth: { resetPassword: vi.fn(), updateProvider: vi.fn() },
  },
}));

import { login, signup, resetPassword } from '../auth';

beforeEach(() => {
  vi.clearAllMocks();
});

// #3 — a missing/undefined password must return a friendly error, never throw.
// The server action is a public endpoint; an API client / autofill glitch can
// post without the field, and `input.password.length` would throw a TypeError
// (page error / spinner hang) before the try-block.
describe('signup — password presence (#3)', () => {
  it('returns a friendly error when the password is missing (no throw)', async () => {
    const r = await signup({
      email: 'new@pokenic.app',
      password: undefined as unknown as string,
    });
    expect(r).toEqual({ ok: false, error: 'Please enter your password.' });
    expect(mocks.clientFetch).not.toHaveBeenCalled();
  });

  it('returns a friendly error for an empty password', async () => {
    const r = await signup({ email: 'new@pokenic.app', password: '' });
    expect(r).toEqual({ ok: false, error: 'Please enter your password.' });
  });

  it('keeps the length message for a short (but present) password', async () => {
    const r = await signup({ email: 'new@pokenic.app', password: 'abc' });
    expect(r).toEqual({
      ok: false,
      error: 'Password must be at least 8 characters.',
    });
  });
});

describe('resetPassword — password presence (#3)', () => {
  it('returns a friendly error when the password is missing (no throw)', async () => {
    const r = await resetPassword({
      token: 'tok',
      password: undefined as unknown as string,
    });
    expect(r.ok).toBe(false);
  });
});

// #9 (already safe) — fetchProfileHandle self-catches and returns null on any
// error, so a transient handle hiccup yields handle:null, NOT a logout. Pin
// that behaviour so a future refactor can't reintroduce the surprise-logout.
describe('login — handle lookup is non-fatal (#9)', () => {
  it('logs in with handle:null when the handle lookup returns null', async () => {
    mocks.clientFetch.mockResolvedValueOnce({ token: 'tok' }); // exchangeToken
    mocks.customerRetrieve.mockResolvedValueOnce({
      customer: {
        id: 'c1',
        email: 'a@pokenic.app',
        first_name: 'A',
        last_name: null,
      },
    });
    mocks.fetchProfileHandle.mockResolvedValueOnce(null);

    const r = await login({
      email: 'a@pokenic.app',
      password: 'PokenicTest123!',
    });

    expect(r).toEqual({
      ok: true,
      customer: {
        id: 'c1',
        email: 'a@pokenic.app',
        first_name: 'A',
        last_name: null,
        handle: null,
      },
    });
    expect(mocks.clearAuthToken).not.toHaveBeenCalled();
  });
});
