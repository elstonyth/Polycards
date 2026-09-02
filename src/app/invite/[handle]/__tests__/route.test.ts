import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  setReferralCookie: vi.fn(async () => {}),
  getPublicProfile: vi.fn(),
  getAuthToken: vi.fn(),
}));
// Keep the real INVITE_HANDLE_RE; stub only the cookie write.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/referral-cookie', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/referral-cookie')>()),
  setReferralCookie: mocks.setReferralCookie,
}));
vi.mock('@/lib/data/profiles', () => ({
  getPublicProfile: mocks.getPublicProfile,
}));
vi.mock('@/lib/data/customer', () => ({
  getAuthToken: mocks.getAuthToken,
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { GET } from '@/app/invite/[handle]/route';

// The URL stands in for the standalone server's BIND origin: behind the DO
// proxy `request.url` is http://0.0.0.0:3000/…, so an absolute Location built
// from it sends the visitor to a connection error. Every redirect here must
// be a bare RELATIVE Location the browser resolves against the origin it
// actually requested (the same trap #311 fixed for the Google callback).
const invite = (handle: string, headers?: Record<string, string>) =>
  GET(new Request(`http://0.0.0.0:3000/invite/${handle}`, { headers }), {
    params: Promise.resolve({ handle }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthToken.mockResolvedValue(undefined);
  mocks.getPublicProfile.mockResolvedValue({ status: 'ok', profile: {} });
});

describe('GET /invite/[handle] — relative redirects, never the bind origin', () => {
  it('valid handle + logged out → plants the cookie, relative /?invite=<handle>', async () => {
    const res = await invite('demo-wozs');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?invite=demo-wozs');
    expect(mocks.setReferralCookie).toHaveBeenCalledWith('demo-wozs');
  });

  it('logged in → /?invite=has-account, no cookie', async () => {
    mocks.getAuthToken.mockResolvedValue('jwt');

    const res = await invite('demo-wozs');

    expect(res.headers.get('location')).toBe('/?invite=has-account');
    expect(mocks.setReferralCookie).not.toHaveBeenCalled();
  });

  it('dead handle → /?invite=unknown, no cookie', async () => {
    mocks.getPublicProfile.mockResolvedValue({ status: 'notfound' });

    const res = await invite('ghost-nobody-999');

    expect(res.headers.get('location')).toBe('/?invite=unknown');
    expect(mocks.setReferralCookie).not.toHaveBeenCalled();
  });

  it('non-navigation fetch (an <img> stuffing a handle) → bare /, no cookie', async () => {
    const res = await invite('demo-wozs', { 'sec-fetch-mode': 'no-cors' });

    expect(res.headers.get('location')).toBe('/');
    expect(mocks.setReferralCookie).not.toHaveBeenCalled();
  });
});
