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

import { mapFreePackState } from '../free-pack';

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
