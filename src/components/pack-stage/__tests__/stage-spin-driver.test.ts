import { describe, expect, it } from 'vitest';

import { easeOutCubic } from '../stage-spin-driver';

describe('easeOutCubic', () => {
  it('runs 0 to 1, clamped, decelerating', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 12);
  });
});
