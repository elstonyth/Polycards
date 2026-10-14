import { describe, expect, it } from 'vitest';
import { countUpAt } from './use-count-up';

describe('countUpAt', () => {
  it('starts at the old value and lands exactly on the new one', () => {
    expect(countUpAt(10, 110, 0, 900)).toBe(10);
    expect(countUpAt(10, 110, 900, 900)).toBe(110);
    expect(countUpAt(10, 110, 5000, 900)).toBe(110);
  });
  it('eases out: past the linear midpoint halfway through', () => {
    expect(countUpAt(0, 100, 450, 900)).toBeGreaterThan(50);
  });
  it('counts down as well as up, never overshooting', () => {
    const mid = countUpAt(100, 40, 300, 900);
    expect(mid).toBeLessThan(100);
    expect(mid).toBeGreaterThan(40);
  });
  it('jumps straight to the target with no duration', () => {
    expect(countUpAt(0, 7, 0, 0)).toBe(7);
  });
});
