import { describe, expect, it, vi } from 'vitest';

// Mock server-only to avoid Next.js server component guard in tests
vi.mock('server-only', () => ({}));

// Mock dependencies for the module under test
vi.mock('@/lib/medusa', () => ({
  sdk: {
    client: {
      fetch: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
  },
}));

vi.mock('@/lib/data/customer', () => ({
  getAuthToken: vi.fn(),
}));

import { canClaimFreePack, mapFreePackState } from '../free-pack';

describe('mapFreePackState — (token, response) → badge state', () => {
  it('guest + promo:true → signup', () => {
    expect(
      mapFreePackState(false, { eligible: false, slug: null, promo: true }),
    ).toEqual({ mode: 'signup' });
  });

  it('guest + promo:false (or absent) → hidden', () => {
    expect(
      mapFreePackState(false, { eligible: false, slug: null, promo: false }),
    ).toEqual({ mode: 'hidden' });
    expect(mapFreePackState(false, { eligible: false, slug: null })).toEqual({
      mode: 'hidden',
    });
  });

  it('authed + eligible with slug → claim', () => {
    expect(
      mapFreePackState(true, { eligible: true, slug: 'free-welcome' }),
    ).toEqual({ mode: 'claim', slug: 'free-welcome' });
  });

  it('authed + ineligible (claimed / pre-existing / no pack) → hidden', () => {
    expect(mapFreePackState(true, { eligible: false, slug: null })).toEqual({
      mode: 'hidden',
    });
  });

  it('eligible without a slug is not an offer → hidden', () => {
    expect(mapFreePackState(true, { eligible: true, slug: null })).toEqual({
      mode: 'hidden',
    });
  });

  it('unparseable response → hidden, both auth states', () => {
    expect(mapFreePackState(true, null)).toEqual({ mode: 'hidden' });
    expect(mapFreePackState(false, null)).toEqual({ mode: 'hidden' });
  });

  it('authed answer never reads promo — a stray promo:true cannot resurrect a spent claim', () => {
    expect(
      mapFreePackState(true, { eligible: false, slug: null, promo: true }),
    ).toEqual({ mode: 'hidden' });
  });
});

// The /slots/[slug] eligibility branch. A server component has no test net
// here, so this mapper is where that page's behaviour is pinned.
describe('canClaimFreePack — (badge state, slug) → may this visitor claim it', () => {
  it('logged-out visitor still sees the offer, on whatever slug they landed on', () => {
    // Mapping `signup` to false would greet every first-time visitor to the
    // free pack with "already claimed" — both wrong, and the exact funnel the
    // badge exists to feed. `signup` carries no per-customer claim to match a
    // slug against, only the catalog fact that a promo is live.
    expect(canClaimFreePack({ mode: 'signup' }, 'welcome-pack')).toBe(true);
    expect(canClaimFreePack({ mode: 'signup' }, 'anything')).toBe(true);
  });

  it('eligible customer may claim THIS pack', () => {
    expect(
      canClaimFreePack({ mode: 'claim', slug: 'welcome-pack' }, 'welcome-pack'),
    ).toBe(true);
  });

  it('a claim on a DIFFERENT pack does not authorise this one', () => {
    // Guards the window where the operator swaps which free pack is active.
    expect(
      canClaimFreePack({ mode: 'claim', slug: 'other-pack' }, 'welcome-pack'),
    ).toBe(false);
  });

  it('spent claim — or a failed read — withholds the offer', () => {
    // `hidden` is both, and the storefront cannot tell them apart: withhold
    // rather than advertise an offer the backend would refuse.
    expect(canClaimFreePack({ mode: 'hidden' }, 'welcome-pack')).toBe(false);
  });
});
