import { describe, it, expect } from 'vitest';
import { money, rm, rm0, num, relativeTime, affordable } from '../format';

describe('affordable — integer-sen comparison', () => {
  it('does not false-block a fractional cost that a float would', () => {
    // 1.1 * 3 === 3.3000000000000003 > 3.3, so a raw `balance >= cost` would
    // reject a player holding exactly 3.30 for three RM 1.10 packs.
    expect(3.3 >= 1.1 * 3).toBe(false); // the bug this guards
    expect(affordable(3.3, 1.1 * 3)).toBe(true); // the fix
  });

  it('treats an exactly-equal balance as affordable', () => {
    expect(affordable(4.5, 4.5)).toBe(true);
  });

  it('still rejects a genuinely short balance', () => {
    expect(affordable(3.29, 3.3)).toBe(false);
    expect(affordable(0, 1.5)).toBe(false);
  });

  it('handles whole-ringgit prices unchanged', () => {
    expect(affordable(25, 25)).toBe(true);
    expect(affordable(24, 25)).toBe(false);
  });
});

describe('money', () => {
  it('defaults to $ + 2dp', () => {
    expect(money(39.8)).toBe('$39.80');
    expect(money(1234.5)).toBe('$1,234.50');
  });
  it('0 decimals rounds and drops cents', () => {
    expect(money(40, { decimals: 0 })).toBe('$40');
    expect(money(1000.4, { decimals: 0 })).toBe('$1,000');
    expect(money(1000.5, { decimals: 0 })).toBe('$1,001');
  });
  it('custom prefix', () => {
    expect(money(39.8, { prefix: 'US$' })).toBe('US$39.80');
  });
  it('currency style matches Intl currency output', () => {
    expect(money(39.8, { currency: true })).toBe(
      (39.8).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    );
  });
});

describe('rm / rm0 — MYR helpers', () => {
  it('rm formats with RM prefix and 2dp', () => {
    expect(rm(1234.5)).toBe('RM 1,234.50');
  });
  it('rm0 formats with RM prefix and 0dp (rounds)', () => {
    expect(rm0(1234.5)).toBe('RM 1,235');
  });
});

describe('num', () => {
  it('num unchanged', () => {
    expect(num(48250)).toBe((48250).toLocaleString('en-US'));
  });
});

// Injectable clock = a real test surface for the relative-time cascade that was
// duplicated (packs.relativeTime + profile-view.timeAgo) before this seam.
describe('relativeTime', () => {
  const now = new Date('2026-06-16T12:00:00Z');

  it('returns "just now" under a minute', () => {
    expect(relativeTime('2026-06-16T11:59:30Z', now)).toBe('just now');
  });
  it('steps through minutes/hours/days', () => {
    expect(relativeTime('2026-06-16T11:55:00Z', now)).toBe('5m ago');
    expect(relativeTime('2026-06-16T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-06-14T12:00:00Z', now)).toBe('2d ago');
  });
  it('caps at years past 365 days', () => {
    expect(relativeTime('2024-01-01T12:00:00Z', now)).toBe('2y ago');
  });
  it('treats future and unparsable dates as "just now"', () => {
    expect(relativeTime('2026-06-16T13:00:00Z', now)).toBe('just now');
    expect(relativeTime('not-a-date', now)).toBe('just now');
  });
});
