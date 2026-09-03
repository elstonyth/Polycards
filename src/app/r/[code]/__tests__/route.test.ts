import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  setReferralCookie: vi.fn(async () => {}),
  lookupReferralCode: vi.fn(),
  getAuthToken: vi.fn(),
}));
vi.mock('@/lib/referral-cookie', () => ({
  setReferralCookie: mocks.setReferralCookie,
}));
vi.mock('@/lib/data/referral', () => ({
  lookupReferralCode: mocks.lookupReferralCode,
}));
vi.mock('@/lib/data/customer', () => ({
  getAuthToken: mocks.getAuthToken,
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { GET } from '@/app/r/[code]/route';

// The URL stands in for the standalone server's BIND origin: behind the DO
// proxy `request.url` is http://0.0.0.0:3000/…, so an absolute Location built
// from it sends the visitor to a connection error. Every redirect here must
// be a bare RELATIVE Location the browser resolves against the origin it
// actually requested (the same trap #311 fixed for the Google callback).
const visit = (code: string, headers?: Record<string, string>) =>
  GET(new Request(`http://0.0.0.0:3000/r/${code}`, { headers }), {
    params: Promise.resolve({ code }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthToken.mockResolvedValue(undefined);
  mocks.lookupReferralCode.mockResolvedValue({
    status: 'ok',
    code: 'F42B0700',
    name: 'Kenji',
    handle: 'kenji-2c7f',
  });
});

describe('GET /r/[code] — relative redirects, never the bind origin', () => {
  it('valid code + logged out → plants the cookie, relative /?invite=<CODE>', async () => {
    const res = await visit('F42B0700');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?invite=F42B0700');
    expect(mocks.setReferralCookie).toHaveBeenCalledWith('F42B0700');
  });

  it('normalizes a pasted-looking code (lowercase, dashed) before use', async () => {
    const res = await visit('f42b-0700');

    expect(res.headers.get('location')).toBe('/?invite=F42B0700');
    expect(mocks.lookupReferralCode).toHaveBeenCalledWith('F42B0700');
    expect(mocks.setReferralCookie).toHaveBeenCalledWith('F42B0700');
  });

  it('logged in → /?invite=has-account, no cookie, no lookup', async () => {
    mocks.getAuthToken.mockResolvedValue('jwt');

    const res = await visit('F42B0700');

    expect(res.headers.get('location')).toBe('/?invite=has-account');
    expect(mocks.setReferralCookie).not.toHaveBeenCalled();
    expect(mocks.lookupReferralCode).not.toHaveBeenCalled();
  });

  it('unknown code → /?invite=unknown, no cookie', async () => {
    mocks.lookupReferralCode.mockResolvedValue({ status: 'notfound' });

    const res = await visit('ZZZZZZZZ');

    expect(res.headers.get('location')).toBe('/?invite=unknown');
    expect(mocks.setReferralCookie).not.toHaveBeenCalled();
  });

  it('lookup outage → still plants the cookie (the bind re-validates)', async () => {
    mocks.lookupReferralCode.mockResolvedValue({ status: 'error' });

    const res = await visit('F42B0700');

    expect(res.headers.get('location')).toBe('/?invite=F42B0700');
    expect(mocks.setReferralCookie).toHaveBeenCalledWith('F42B0700');
  });

  it('malformed code → bare /, no lookup, no cookie', async () => {
    const res = await visit('nope');

    expect(res.headers.get('location')).toBe('/');
    expect(mocks.lookupReferralCode).not.toHaveBeenCalled();
    expect(mocks.setReferralCookie).not.toHaveBeenCalled();
  });

  it('non-navigation fetch (an <img> stuffing a code) → bare /, no cookie', async () => {
    const res = await visit('F42B0700', { 'sec-fetch-mode': 'no-cors' });

    expect(res.headers.get('location')).toBe('/');
    expect(mocks.setReferralCookie).not.toHaveBeenCalled();
  });
});
