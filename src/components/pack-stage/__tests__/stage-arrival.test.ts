import { beforeEach, describe, expect, it } from 'vitest';

import {
  ARRIVAL_WINDOW_MS,
  markArrival,
  peekArrival,
  resetArrivalForTests,
  takeArrival,
} from '../stage-arrival';

describe('the arrival flag', () => {
  beforeEach(() => resetArrivalForTests());

  it('is unset by default', () => {
    expect(peekArrival(0)).toBe(false);
    expect(takeArrival(0)).toBe(false);
  });

  it('peek has no side effect; take consumes it once', () => {
    markArrival(1000);
    expect(peekArrival(1200)).toBe(true);
    expect(peekArrival(1300)).toBe(true);
    expect(takeArrival(1400)).toBe(true);
    expect(takeArrival(1401)).toBe(false);
    expect(peekArrival(1402)).toBe(false);
  });

  it('goes stale after 5 s, and take clears a stale one', () => {
    markArrival(0);
    expect(peekArrival(ARRIVAL_WINDOW_MS)).toBe(true);
    expect(peekArrival(ARRIVAL_WINDOW_MS + 1)).toBe(false);
    expect(takeArrival(ARRIVAL_WINDOW_MS + 1)).toBe(false);
    markArrival(10_000);
    expect(takeArrival(10_001)).toBe(true);
  });

  it('works with the default clock', () => {
    markArrival();
    expect(peekArrival()).toBe(true);
    expect(takeArrival()).toBe(true);
  });
});
