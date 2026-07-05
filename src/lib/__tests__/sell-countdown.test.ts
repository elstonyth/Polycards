import { describe, it, expect, test } from 'vitest';
import {
  SELL_COUNTDOWN_SECS,
  sellSecondsLeft,
  sharedDeadlineMs,
} from '@/lib/sell-countdown';

describe('SELL_COUNTDOWN_SECS', () => {
  it('is the strict 30s display window', () => {
    expect(SELL_COUNTDOWN_SECS).toBe(30);
  });
});

describe('sellSecondsLeft', () => {
  it('rounds partial seconds up and never goes below zero', () => {
    const now = 1_000_000;
    expect(sellSecondsLeft(now + 30_000, now)).toBe(30);
    expect(sellSecondsLeft(now + 1, now)).toBe(1); // partial rounds up
    expect(sellSecondsLeft(now, now)).toBe(0);
    expect(sellSecondsLeft(now - 5_000, now)).toBe(0); // never negative
  });
});

describe('sharedDeadlineMs', () => {
  test('returns the earliest finite deadline', () => {
    expect(sharedDeadlineMs([2000, 1500, 3000])).toBe(1500);
  });
  test('ignores null/undefined entries', () => {
    expect(sharedDeadlineMs([null, 2500, undefined])).toBe(2500);
  });
  test('null when no usable deadline', () => {
    expect(sharedDeadlineMs([])).toBeNull();
    expect(sharedDeadlineMs([null, undefined])).toBeNull();
  });
});
