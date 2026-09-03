/**
 * lookupReferralCode (src/lib/data/referral.ts) — the public owner-of-code
 * check behind /r/<code> and the signup form. A status union that never
 * throws: callers branch on 'notfound' vs 'error' (an outage must not punish
 * the visitor), so both mappings are pinned here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchError } from '@medusajs/js-sdk';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/medusa', () => ({ sdk: { client: { fetch: fetchMock } } }));
vi.mock('@/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('@/lib/data/customer', () => ({ getAuthToken: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { lookupReferralCode } from '@/lib/data/referral';

beforeEach(() => {
  fetchMock.mockReset();
});

describe('lookupReferralCode', () => {
  it('returns the public fields for a known code', async () => {
    fetchMock.mockResolvedValue({
      code: 'F42B0700',
      handle: 'kenji-2c7f',
      name: 'Kenji',
    });

    expect(await lookupReferralCode('F42B0700')).toEqual({
      status: 'ok',
      code: 'F42B0700',
      handle: 'kenji-2c7f',
      name: 'Kenji',
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('/store/referral/codes/F42B0700');
  });

  it("maps the backend's 404 to 'notfound'", async () => {
    fetchMock.mockRejectedValue(new FetchError('Not found', 'Not Found', 404));
    expect(await lookupReferralCode('ZZZZZZZZ')).toEqual({
      status: 'notfound',
    });
  });

  it("maps any other failure to 'error' (our outage, not the visitor's)", async () => {
    fetchMock.mockRejectedValue(
      new FetchError('Bad gateway', 'Bad Gateway', 502),
    );
    expect(await lookupReferralCode('F42B0700')).toEqual({ status: 'error' });

    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await lookupReferralCode('F42B0701')).toEqual({ status: 'error' });
  });

  it("treats a payload that fails the schema as 'error', not a match", async () => {
    fetchMock.mockResolvedValue({ unexpected: true });
    expect(await lookupReferralCode('F42B0702')).toEqual({ status: 'error' });
  });
});
