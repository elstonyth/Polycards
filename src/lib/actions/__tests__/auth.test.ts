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
  // Referenceable handle for logger.error so the keys-only assertion (case 4)
  // can inspect the logged args; googleLoginStart also needs next/headers.
  logError: vi.fn(),
  headers: vi.fn(),
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
  logger: {
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
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

import {
  login,
  signup,
  resetPassword,
  googleLoginStart,
  googleCallback,
} from '../auth';

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
      email: 'new@polycards.app',
      password: undefined as unknown as string,
    });
    expect(r).toEqual({ ok: false, error: 'Please enter your password.' });
    expect(mocks.clientFetch).not.toHaveBeenCalled();
  });

  it('returns a friendly error for an empty password', async () => {
    const r = await signup({ email: 'new@polycards.app', password: '' });
    expect(r).toEqual({ ok: false, error: 'Please enter your password.' });
  });

  it('keeps the length message for a short (but present) password', async () => {
    const r = await signup({ email: 'new@polycards.app', password: 'abc' });
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
    expect(r).toEqual({ ok: false, error: 'Please enter your password.' });
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
        email: 'a@polycards.app',
        first_name: 'A',
        last_name: null,
      },
    });
    mocks.fetchProfileHandle.mockResolvedValueOnce(null);

    const r = await login({
      email: 'a@polycards.app',
      password: 'PolycardsTest123!',
    });

    expect(r).toEqual({
      ok: true,
      customer: {
        id: 'c1',
        email: 'a@polycards.app',
        first_name: 'A',
        last_name: null,
        handle: null,
        avatar_url: null,
      },
    });
    expect(mocks.clearAuthToken).not.toHaveBeenCalled();
  });
});

// --- Google OAuth server actions (plan 053) -------------------------------

// Mirrors decodeJwtPayload: split('.')[1] base64url-decoded to JSON.
const makeToken = (payload: object) =>
  'h.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.s';

// headers() is awaited; a plain object with get() is enough.
const setHeaders = (rec: Record<string, string>) =>
  mocks.headers.mockReturnValue({ get: (k: string) => rec[k] ?? null });

describe('googleCallback — OAuth callback branches', () => {
  it('missing code/state → cancelled, never touches the backend', async () => {
    const r = await googleCallback({});
    expect(r).toEqual({
      ok: false,
      error: 'Google sign-in was cancelled or failed.',
    });
    expect(mocks.clientFetch).not.toHaveBeenCalled();
  });

  it('returning user → ok:true, stores the ORIGINAL token, no create/refresh', async () => {
    const token = makeToken({ actor_id: 'cus_1' });
    mocks.clientFetch.mockResolvedValueOnce({ token }); // callback GET
    mocks.customerRetrieve.mockResolvedValueOnce({
      customer: {
        id: 'cus_1',
        email: 'ret@polycards.app',
        first_name: 'R',
        last_name: null,
      },
    });
    mocks.fetchProfileHandle.mockResolvedValueOnce('rhandle');

    const r = await googleCallback({ code: 'c', state: 's' });

    expect(r.ok).toBe(true);
    expect(mocks.setAuthToken).toHaveBeenCalledWith(token);
    expect(mocks.customerCreate).not.toHaveBeenCalled();
    // Only the callback GET — a refresh would be a second clientFetch call.
    expect(mocks.clientFetch).toHaveBeenCalledTimes(1);
  });

  it('first login → normalizes email, refreshes, stores the REFRESHED token', async () => {
    const first = makeToken({
      actor_id: '',
      user_metadata: {
        email: 'MiXeD@Example.COM',
        given_name: 'A',
        family_name: 'B',
      },
    });
    const refreshed = makeToken({ actor_id: 'cus_new' });
    mocks.clientFetch
      .mockResolvedValueOnce({ token: first }) // callback GET
      .mockResolvedValueOnce({ token: refreshed }); // /auth/token/refresh
    mocks.customerCreate.mockResolvedValueOnce({ customer: { id: 'cus_new' } });
    mocks.customerRetrieve.mockResolvedValueOnce({
      customer: {
        id: 'cus_new',
        email: 'mixed@example.com',
        first_name: 'A',
        last_name: 'B',
      },
    });
    mocks.fetchProfileHandle.mockResolvedValueOnce('h');

    const r = await googleCallback({ code: 'c', state: 's' });

    expect(r.ok).toBe(true);
    // Normalization: mixed-case Google email is lowercased before create.
    const [body, , authHeader] = mocks.customerCreate.mock.calls[0]!;
    expect(body.email).toBe('mixed@example.com');
    expect(authHeader.Authorization).toBe(`Bearer ${first}`);
    // Refresh happened against the first (register) token's Bearer.
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      '/auth/token/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: `Bearer ${first}` },
      }),
    );
    // The session cookie gets the refreshed token, never the register one.
    expect(mocks.setAuthToken).toHaveBeenCalledWith(refreshed);
  });

  // Decoy PII rides in the payload (top-level `email`, and a `user_metadata`
  // value) but `user_metadata.email` stays absent so the missing-email branch
  // still fires. This makes the assertions load-bearing: a values-logging
  // regression (e.g. Object.values instead of Object.keys) would put an `@`
  // in the log and fail `not.toMatch(/@/)`, and would break the key-NAME check.
  it.each([
    [
      'user_metadata present, email absent',
      {
        actor_id: '',
        email: 'decoy@leak.example',
        user_metadata: { name: 'x@y.example' },
      },
      ['name'],
    ],
    ['user_metadata absent', { actor_id: '', email: 'decoy@leak.example' }, []],
  ])(
    'missing email (%s) → keys-only log, no PII value leaked',
    async (_label, payload, expectedUserMetadataKeys) => {
      mocks.clientFetch.mockResolvedValueOnce({ token: makeToken(payload) });

      const r = await googleCallback({ code: 'c', state: 's' });

      expect(r).toEqual({
        ok: false,
        error: 'Google did not share a verified email.',
      });
      expect(mocks.customerCreate).not.toHaveBeenCalled();
      expect(mocks.logError).toHaveBeenCalledTimes(1);
      const errorCall = mocks.logError.mock.calls[0]!;
      // Security: no PII value (email) anywhere in the logged args.
      expect(JSON.stringify(errorCall)).not.toMatch(/@/);
      // Pin the key NAMES — an array of VALUES would not contain these strings.
      const meta = errorCall[1] as {
        payloadKeys: string[];
        userMetadataKeys: string[];
      };
      expect(meta.payloadKeys).toEqual(
        expect.arrayContaining(['actor_id', 'email']),
      );
      expect(meta.userMetadataKeys).toEqual(expectedUserMetadataKeys);
    },
  );

  it('callback fetch rejects → friendly error, NEITHER setAuthToken NOR clearAuthToken', async () => {
    mocks.clientFetch.mockRejectedValueOnce(new Error('network down'));

    const r = await googleCallback({ code: 'c', state: 's' });

    expect(r).toEqual({
      ok: false,
      error: 'Could not complete Google sign-in. Please try again.',
    });
    expect(mocks.setAuthToken).not.toHaveBeenCalled();
    expect(mocks.clearAuthToken).not.toHaveBeenCalled();
  });

  it('retrieve fails after setAuthToken → clearAuthToken (no broken cookie left)', async () => {
    const token = makeToken({ actor_id: 'cus_1' });
    mocks.clientFetch.mockResolvedValueOnce({ token });
    mocks.customerRetrieve.mockRejectedValueOnce(new Error('retrieve boom'));

    const r = await googleCallback({ code: 'c', state: 's' });

    expect(r.ok).toBe(false);
    expect(mocks.setAuthToken).toHaveBeenCalledWith(token);
    expect(mocks.clearAuthToken).toHaveBeenCalled();
    // setAuthToken must run before clearAuthToken (set, then clear on failure).
    expect(mocks.setAuthToken.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.clearAuthToken.mock.invocationCallOrder[0]!,
    );
  });

  it('refresh fails after create → error, unrefreshed token NEVER stored', async () => {
    const first = makeToken({
      actor_id: '',
      user_metadata: { email: 'x@y.com' },
    });
    mocks.clientFetch
      .mockResolvedValueOnce({ token: first }) // callback GET
      .mockRejectedValueOnce(new Error('refresh down')); // /auth/token/refresh
    mocks.customerCreate.mockResolvedValueOnce({ customer: { id: 'cus_new' } });

    const r = await googleCallback({ code: 'c', state: 's' });

    expect(r.ok).toBe(false);
    expect(mocks.customerCreate).toHaveBeenCalled();
    expect(mocks.setAuthToken).not.toHaveBeenCalled();
  });
});

describe('googleLoginStart — callback_url host guard', () => {
  it('allowed host + x-forwarded-proto https → ok:true, https callback_url', async () => {
    setHeaders({ host: 'polycards.gg', 'x-forwarded-proto': 'https' });
    mocks.clientFetch.mockResolvedValueOnce({
      location: 'https://accounts.google/x',
    });

    const r = await googleLoginStart();

    expect(r).toEqual({ ok: true, location: 'https://accounts.google/x' });
    const [path, opts] = mocks.clientFetch.mock.calls[0]!;
    expect(path).toBe('/auth/customer/google');
    expect(opts.body.callback_url).toBe(
      'https://polycards.gg/auth/google/callback',
    );
  });

  it('disallowed host → origin error, no backend call', async () => {
    setHeaders({ host: 'evil.example.com' });

    const r = await googleLoginStart();

    expect(r).toEqual({
      ok: false,
      error: 'Could not determine site origin.',
    });
    expect(mocks.clientFetch).not.toHaveBeenCalled();
  });

  it('backend returns no location → unavailable', async () => {
    setHeaders({ host: 'polycards.gg', 'x-forwarded-proto': 'https' });
    mocks.clientFetch.mockResolvedValueOnce({});

    const r = await googleLoginStart();

    expect(r).toEqual({
      ok: false,
      error: 'Google sign-in is currently unavailable.',
    });
  });
});
