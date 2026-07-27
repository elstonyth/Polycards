import { describe, it, expect } from 'vitest';
import {
  rm,
  timeAgo,
  fmtPct,
  usdToMyr,
  gradeToGrader,
  orderDateTime,
  deliveryStatusLabel,
} from './format';

describe('deliveryStatusLabel', () => {
  it('titles a canonical status', () => {
    expect(deliveryStatusLabel('ready_to_ship')).toBe('Ready to ship');
  });
  // A rollback or the PRE_DEPLOY window can still write the pre-rename
  // 'packing'/'delivered' (Migration20260727000000 keeps the CHECK widened),
  // and an unlabeled status renders as an empty badge — which reads as a
  // broken order rather than an old one.
  it('falls back to the raw token for a legacy status', () => {
    expect(deliveryStatusLabel('packing')).toBe('packing');
    expect(deliveryStatusLabel('delivered')).toBe('delivered');
  });
});

describe('rm', () => {
  it('formats a number with two decimals and an RM prefix', () => {
    expect(rm(12.5)).toBe('RM 12.50');
  });
  it('formats a whole number with grouping and trailing zeros', () => {
    expect(rm(1000)).toBe('RM 1,000.00');
  });
  it('returns an em dash for null', () => {
    expect(rm(null)).toBe('—');
  });
});

describe('timeAgo', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0); // fixed clock (ms)

  it('returns "just now" under a minute', () => {
    expect(timeAgo(new Date(now - 30_000).toISOString(), now)).toBe('just now');
  });
  it('returns whole minutes', () => {
    expect(timeAgo(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m ago');
  });
  it('returns whole hours', () => {
    expect(timeAgo(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3h ago');
  });
  it('returns whole days', () => {
    expect(timeAgo(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2d ago');
  });
  it('returns an em dash for an invalid ISO string', () => {
    expect(timeAgo('not-a-date', now)).toBe('—');
  });
  it('returns "1m ago" at exactly 60 seconds', () => {
    expect(timeAgo(new Date(now - 60_000).toISOString(), now)).toBe('1m ago');
  });
  it('returns "1h ago" at exactly 60 minutes', () => {
    expect(timeAgo(new Date(now - 3_600_000).toISOString(), now)).toBe('1h ago');
  });
  it('returns "1d ago" at exactly 24 hours', () => {
    expect(timeAgo(new Date(now - 86_400_000).toISOString(), now)).toBe('1d ago');
  });
  it('clamps a future timestamp to "just now"', () => {
    expect(timeAgo(new Date(now + 5_000).toISOString(), now)).toBe('just now');
  });
});

// usdToMyr is a hand-mirror of the backend displayMarketPrice(usd, fx, 1)
// (backend/packages/api/src/modules/packs/pricing.ts) — same rule
// `Math.round(usd * fx * 100) / 100`, same finite/positive-fx guards. @acme/api
// exports only `./_generated`, so displayMarketPrice can't be imported here to
// assert equality directly (Option A blocked by the exports field); instead this
// table encodes the shared rule so the mirror can't silently drift. If the
// backend rounding basis changes, update BOTH functions and this table.
//
// The mirror is complete: usdToMyr guards `usd >= 0` exactly like
// displayMarketPrice's `raw < 0` guard, so both collapse every bad input
// (non-finite, fx <= 0, negative usd) to 0 and agree on the whole domain.
describe('usdToMyr — parity with backend displayMarketPrice(usd, fx, 1)', () => {
  it.each([
    // usd,     fx,    expected = Math.round(usd*fx*100)/100
    [8.47, 4.7, 39.81], // float basis: 8.47*4.7 = 39.808999… → 39.81
    [10, 4.7, 47], // exact
    [0.01, 4.7, 0.05], // small: 0.047 → rounds up
    [1234.56, 4.73, 5839.47], // non-integer fx, large usd
    [1_000_000, 4.7, 4_700_000], // large usd
    [0.125, 1, 0.13], // half-up rounding at .xx5
    [0, 4.7, 0], // zero usd
  ])('usdToMyr(%f, %f) === %f', (usd, fx, expected) => {
    expect(usdToMyr(usd, fx)).toBe(expected);
  });

  it.each([
    ['fx = 0', 10, 0],
    ['fx < 0', 10, -4.7],
    ['fx = Infinity', 10, Infinity],
    ['fx = NaN', 10, NaN],
    ['usd = NaN', NaN, 4.7],
    ['usd = Infinity', Infinity, 4.7],
    ['usd < 0 (matches displayMarketPrice raw < 0 guard)', -5, 4.7],
  ])('collapses to 0 on bad input (%s)', (_label, usd, fx) => {
    expect(usdToMyr(usd, fx)).toBe(0);
  });
});

describe('gradeToGrader', () => {
  it.each([
    ['PSA 10', { grader: 'PSA', grade: '10' }],
    ['BGS 9.5', { grader: 'BGS', grade: '9.5' }],
    ['CGC 8', { grader: 'CGC', grade: '8' }],
    ['SGC 7', { grader: 'SGC', grade: '7' }],
  ])('splits a graded PC tier label %s', (label, expected) => {
    expect(gradeToGrader(label)).toEqual(expected);
  });

  it('parses a generic "Grade N" tier as ungraded (§3a — price comp, not a PSA claim)', () => {
    expect(gradeToGrader('Grade 9')).toEqual({ grader: '', grade: '9' });
  });

  it('falls back to the raw label as the grade when nothing matches', () => {
    expect(gradeToGrader('Loose')).toEqual({ grader: '', grade: 'Loose' });
  });
});

describe('orderDateTime', () => {
  // Built in LOCAL time and round-tripped through ISO, so the expectation
  // holds in any timezone the operator's machine runs in.
  const local = (h: number, min: number) =>
    new Date(2026, 6, 4, h, min).toISOString();

  it('formats as dd-MM-yyyy hh:mm a with zero padding', () => {
    expect(orderDateTime(local(15, 7))).toBe('04-07-2026 03:07 PM');
  });
  // The `h % 12 || 12` branch: hour 0 and hour 12 are the only ones that don't
  // fall out of a plain modulo.
  it('renders midnight as 12 AM, not 00 AM', () => {
    expect(orderDateTime(local(0, 5))).toBe('04-07-2026 12:05 AM');
  });
  it('renders noon as 12 PM', () => {
    expect(orderDateTime(local(12, 0))).toBe('04-07-2026 12:00 PM');
  });
  it('returns an em dash for an unparseable date', () => {
    expect(orderDateTime('not-a-date')).toBe('—');
  });
});

describe('fmtPct', () => {
  it('formats an integer without decimals', () => {
    expect(fmtPct(20)).toBe('20%');
  });
  it('formats a fractional value with two decimals', () => {
    expect(fmtPct(12.5)).toBe('12.50%');
  });
});
