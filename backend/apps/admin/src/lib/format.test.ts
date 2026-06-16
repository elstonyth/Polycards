import { describe, it, expect } from 'vitest';
import { usd, timeAgo, fmtPct } from './format';

describe('usd', () => {
  it('formats a number with two decimals and a dollar sign', () => {
    expect(usd(12.5)).toBe('$12.50');
  });
  it('formats a whole number with grouping and trailing zeros', () => {
    expect(usd(1000)).toBe('$1,000.00');
  });
  it('returns an em dash for null', () => {
    expect(usd(null)).toBe('—');
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
});

describe('fmtPct', () => {
  it('formats an integer without decimals', () => {
    expect(fmtPct(20)).toBe('20%');
  });
  it('formats a fractional value with two decimals', () => {
    expect(fmtPct(12.5)).toBe('12.50%');
  });
});
