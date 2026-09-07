/**
 * The two /store/referral reads (src/lib/data/referral.ts).
 *
 * lookupReferralCode is the PUBLIC owner-of-code check behind /r/<code> and
 * the signup form: a status union that never throws, where callers branch on
 * 'notfound' vs 'error' (an outage must not punish the visitor), so both
 * mappings are pinned here. getReferralSummary is the per-customer panel, and
 * the two must not drift into each other — one sends no bearer, the other
 * must.
 */
import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/store', () => ({ store: storeShim }));

import { lookupReferralCode, getReferralSummary } from '@/lib/data/referral';

const CODE_ROUTE = 'GET /store/referral/codes/:code';

describe('lookupReferralCode', () => {
  it('returns the public fields for a known code', async () => {
    const mem = backend({
      [CODE_ROUTE]: {
        body: { code: 'F42B0700', handle: 'kenji-2c7f', name: 'Kenji' },
      },
    });

    expect(await lookupReferralCode('F42B0700')).toEqual({
      status: 'ok',
      code: 'F42B0700',
      handle: 'kenji-2c7f',
      name: 'Kenji',
    });
    // Public: no Authorization, and no cache key on the wire.
    expect(mem.requests[0]).toEqual({
      method: 'GET',
      path: '/store/referral/codes/F42B0700',
      headers: {},
      cache: 'auto',
    });
  });

  it("maps the backend's 404 to 'notfound'", async () => {
    backend({ [CODE_ROUTE]: { status: 404, body: { message: 'Not found' } } });
    expect(await lookupReferralCode('ZZZZZZZZ')).toEqual({
      status: 'notfound',
    });
  });

  it("maps any other failure to 'error' (our outage, not the visitor's)", async () => {
    backend({
      [CODE_ROUTE]: { status: 502, body: { message: 'Bad gateway' } },
    });
    expect(await lookupReferralCode('F42B0700')).toEqual({ status: 'error' });

    // Pre-port the second case was a status-less throw; the port classifies on
    // status alone, so a bodyless failure stands in for it here (the
    // status-less variant itself is pinned in store.test.ts).
    backend({ [CODE_ROUTE]: { status: 503 } });
    expect(await lookupReferralCode('F42B0701')).toEqual({ status: 'error' });
  });

  it("treats a payload that fails the schema as 'error', not a match", async () => {
    backend({ [CODE_ROUTE]: { body: { unexpected: true } } });
    expect(await lookupReferralCode('F42B0702')).toEqual({ status: 'error' });
  });
});

describe('getReferralSummary', () => {
  const summary = {
    handle: 'kenji-2c7f',
    code: 'F42B0700',
    downline_count: 3,
    week: {
      start: '2026-09-01',
      turnover_cents: 1000,
      rate_bp: 250,
      projected_cents: 25,
      partner: false,
    },
    history: [],
  };

  it('reads /store/referral with the customer bearer', async () => {
    const mem = backend({ 'GET /store/referral': { body: summary } });
    expect(await getReferralSummary()).toMatchObject({ code: 'F42B0700' });
    expect(mem.requests[0]).toEqual({
      method: 'GET',
      path: '/store/referral',
      headers: { Authorization: 'Bearer test-token' },
      cache: 'no-store',
    });
  });

  it('is null for a logged-out visitor, without leaving the storefront', async () => {
    const mem = backend(
      { 'GET /store/referral': { body: summary } },
      { token: null },
    );
    expect(await getReferralSummary()).toBeNull();
    expect(mem.requests).toHaveLength(0);
  });

  it('is null on a backend failure and on a malformed 200 — one panel for all three', async () => {
    backend({ 'GET /store/referral': { status: 500, body: {} } });
    expect(await getReferralSummary()).toBeNull();
    backend({ 'GET /store/referral': { body: { handle: 'x' } } });
    expect(await getReferralSummary()).toBeNull();
  });
});
