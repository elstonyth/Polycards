import { describe, expect, it } from 'vitest';

import {
  PAGE_MS,
  SAME_FRAMING_MS,
  createPager,
  durationFor,
} from '../stage-pager';

const P = 716;
const STOPS = [0, 1, 2, 3, 4, 5, 6].map((k) => 1000 + k * 1.25 * P);
const KINDS = ['front', 'tophits', 'odds', 'buyback', 'pulls', 'closing'];

function pager() {
  const p = createPager();
  p.setStops(STOPS);
  p.setDuration(durationFor(KINDS));
  return p;
}

/** Runs frames until the move ends; returns the end time and scroll. */
function settle(p: ReturnType<typeof createPager>, y: number, t: number) {
  let scroll = y;
  let now = t;
  for (let i = 0; i < 400; i++) {
    now += 16;
    const f = p.frame(scroll, now);
    if (f.scrollTo !== null) scroll = f.scrollTo;
    if (!f.animating) return { now, scroll, f };
  }
  throw new Error('no settle');
}

describe('stage pager', () => {
  it('one wheel gesture = one stop, 1.5 s ease-out', () => {
    const p = pager();
    expect(p.wheel(40, 0, false, STOPS[1]!, 0)).toBe(true);
    const mid = p.frame(STOPS[1]!, 750);
    expect(mid.animating).toBe(true);
    // ease-out cubic at t = 0.5: 87.5% of the way
    expect(mid.focus).toBeCloseTo(1.875, 3);
    const { now, scroll } = settle(p, mid.scrollTo!, 750);
    expect(scroll).toBe(STOPS[2]);
    expect(now).toBeGreaterThanOrEqual(PAGE_MS);
    expect(now).toBeLessThan(PAGE_MS + 32);
  });

  it('1.0 s between Pull Odds and Buyback, both ways; 1.5 s elsewhere', () => {
    const d = durationFor(KINDS);
    expect(d(3, 4)).toBe(SAME_FRAMING_MS);
    expect(d(4, 3)).toBe(SAME_FRAMING_MS);
    expect(d(2, 3)).toBe(PAGE_MS);
    expect(d(0, 1)).toBe(PAGE_MS);
    expect(d(4, 5)).toBe(PAGE_MS);
    const p = pager();
    p.wheel(40, 0, false, STOPS[3]!, 0);
    const { now, scroll } = settle(p, STOPS[3]!, 0);
    expect(scroll).toBe(STOPS[4]);
    expect(now).toBeLessThan(SAME_FRAMING_MS + 32);
  });

  it('events during a move are swallowed, reverse ones too', () => {
    const p = pager();
    p.wheel(40, 0, false, STOPS[1]!, 0);
    expect(p.wheel(-80, 0, false, STOPS[1]!, 200)).toBe(true);
    expect(p.wheel(80, 0, false, STOPS[1]!, 400)).toBe(true);
    const { scroll } = settle(p, STOPS[1]!, 400);
    expect(scroll).toBe(STOPS[2]);
  });

  it('the gap rule: a momentum tail after a move never pages again', () => {
    const p = pager();
    p.wheel(60, 0, false, STOPS[1]!, 0);
    let t = 0;
    let d = 60;
    // a decaying tail every 16 ms through the move and after it
    while (t < 2200) {
      t += 16;
      d = Math.max(1, d * 0.97);
      p.frame(STOPS[2]!, t);
      p.wheel(d, 0, false, STOPS[2]!, t);
    }
    expect(p.busy()).toBe(false);
    expect(Math.round(p.focusAt(STOPS[2]!))).toBe(2);
    // a pause over 120 ms, then a new gesture: pages
    expect(p.wheel(30, 0, false, STOPS[2]!, t + 200)).toBe(true);
    expect(p.busy()).toBe(true);
  });

  it('a rise in |deltaY| starts a new gesture without a gap', () => {
    const p = pager();
    p.wheel(20, 0, false, STOPS[1]!, 0);
    for (let t = 16; t <= 1600; t += 16) {
      p.frame(STOPS[2]!, t);
      p.wheel(5, 0, false, STOPS[2]!, t);
    }
    expect(p.busy()).toBe(false);
    p.wheel(40, 0, false, STOPS[2]!, 1616);
    expect(p.busy()).toBe(true);
  });

  it('tiny deltas and sideways wheels do not page', () => {
    const p = pager();
    expect(p.wheel(3, 0, false, STOPS[1]!, 0)).toBe(true);
    expect(p.busy()).toBe(false);
    expect(p.wheel(10, 40, false, STOPS[1]!, 500)).toBe(false);
    expect(p.wheel(40, 0, true, STOPS[1]!, 1000)).toBe(false);
    expect(p.busy()).toBe(false);
  });

  it('touch: over 24 px pages one stop on release, less stays', () => {
    const p = pager();
    p.touchStart(200, 500, 0);
    expect(p.touchMove(200, 490)).toBe(true);
    p.touchEnd(STOPS[2]!, 100);
    expect(p.busy()).toBe(false);
    p.touchStart(200, 500, 200);
    p.touchMove(200, 300);
    p.touchEnd(STOPS[2]!, 300);
    const { scroll } = settle(p, STOPS[2]!, 300);
    expect(scroll).toBe(STOPS[3]);
  });

  it('a held finger never moves the page (only the frame writes it)', () => {
    const p = pager();
    p.touchStart(200, 500, 0);
    for (let y = 498; y > 100; y -= 4) expect(p.touchMove(200, y)).toBe(true);
    const f = p.frame(STOPS[2]!, 5000);
    expect(f.scrollTo).toBeNull();
    expect(p.busy()).toBe(false);
  });

  it('a touch during a move is ignored', () => {
    const p = pager();
    p.wheel(40, 0, false, STOPS[1]!, 0);
    p.touchStart(200, 500, 300);
    p.touchMove(200, 200);
    p.touchEnd(STOPS[1]!, 400);
    const { scroll } = settle(p, STOPS[1]!, 400);
    expect(scroll).toBe(STOPS[2]);
  });

  it('a horizontal touch (the strip) is not consumed and never pages', () => {
    const p = pager();
    p.touchStart(300, 500, 0);
    expect(p.touchMove(290, 500)).toBe(false);
    expect(p.touchMove(100, 470)).toBe(false);
    p.touchEnd(STOPS[2]!, 100);
    expect(p.busy()).toBe(false);
  });

  it('nothing past the last stop; back from Front is the row', () => {
    const p = pager();
    p.wheel(40, 0, false, STOPS[6]!, 0);
    expect(p.busy()).toBe(false);
    p.wheel(-40, 0, false, STOPS[1]!, 500);
    const { scroll, f } = settle(p, STOPS[1]!, 500);
    expect(scroll).toBe(STOPS[0]);
    expect(f.focus).toBe(0);
  });

  it('goTo jumps several stops in one move', () => {
    const p = pager();
    expect(p.goTo(5, STOPS[1]!, 0)).toBe(true);
    expect(p.goTo(2, STOPS[1]!, 10)).toBe(false);
    const { scroll } = settle(p, STOPS[1]!, 0);
    expect(scroll).toBe(STOPS[5]);
  });
});
