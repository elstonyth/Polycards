import { describe, it, expect } from 'vitest';
import { clampRect } from '@/lib/avatar-crop';

describe('clampRect', () => {
  it('passes an in-bounds rect through, rounded', () => {
    expect(
      clampRect({ x: 10.4, y: 20.6, width: 100.2, height: 100.2 }, 400, 400),
    ).toEqual({ x: 10, y: 21, width: 100, height: 100 });
  });

  it('slides a rect that rounds past the right/bottom edge back inside', () => {
    // The sliver bug: x+width > naturalWidth makes drawImage fill the overrun
    // with transparency instead of pixels.
    const r = clampRect({ x: 350, y: 350, width: 120, height: 120 }, 400, 400);
    expect(r.x + r.width).toBeLessThanOrEqual(400);
    expect(r.y + r.height).toBeLessThanOrEqual(400);
  });

  it('stays square (the canvas is square — a trimmed side would stretch)', () => {
    const r = clampRect({ x: 300, y: 300, width: 120, height: 150 }, 400, 400);
    expect(r.width).toBe(r.height);
    expect(r.x + r.width).toBeLessThanOrEqual(400);
    expect(r.y + r.height).toBeLessThanOrEqual(400);
  });

  it('shrinks to fit an image smaller than the requested crop', () => {
    const r = clampRect({ x: 0, y: 0, width: 500, height: 500 }, 200, 300);
    expect(r).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });

  it('pulls a negative origin back inside the image', () => {
    expect(
      clampRect({ x: -5, y: -30, width: 50, height: 50 }, 400, 400),
    ).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  it('never returns a zero-size rect', () => {
    const r = clampRect({ x: 399, y: 399, width: 0, height: 0 }, 400, 400);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });
});
