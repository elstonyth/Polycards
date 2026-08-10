import { describe, expect, it } from 'vitest';
import { countedFrame } from './use-counted-value';

describe('countedFrame', () => {
  it('starts at `from` and lands exactly on `to`', () => {
    expect(countedFrame(100, 250, 0, 650)).toBe(100);
    expect(countedFrame(100, 250, 650, 650)).toBe(250);
  });

  it('clamps a late frame to the target instead of overshooting', () => {
    expect(countedFrame(100, 250, 5000, 650)).toBe(250);
    expect(countedFrame(100, 250, -20, 650)).toBe(100);
  });

  it('counts down as well as up', () => {
    const mid = countedFrame(250, 100, 325, 650);
    expect(mid).toBeLessThan(250);
    expect(mid).toBeGreaterThan(100);
  });

  it('eases out — past halfway by the time half the duration is gone', () => {
    expect(countedFrame(0, 100, 325, 650)).toBeGreaterThan(50);
  });
});
