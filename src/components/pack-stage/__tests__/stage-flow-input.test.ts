import { describe, expect, it } from 'vitest';

import { createFlowInput, type FlowInput } from '../stage-flow-input';
import { focusStops } from '../stage-focus-keys';

// panel 800: S = 1000; rests 1000..6000, RL 7000, edge 7500, exit 8000 to 9000
const GEO = { top: 0, panel: 800, viewport: 800 };
const SLEEVE = focusStops('sleeve');

/** A page with a centred pack: focusable (sleeve) unless `kinds` is null. */
function page(kinds: readonly string[] | null = SLEEVE) {
  const calls: string[] = [];
  let on = false;
  const input = createFlowInput({
    centreKinds: () => kinds,
    focused: () => on,
    kinds: () => (on ? (kinds ?? []) : []),
    enter: () => {
      calls.push('enter');
      if (!kinds) return false;
      on = true;
      return true;
    },
  });
  input.measure(GEO, 0);
  return {
    input,
    calls,
    end: () => {
      on = false;
    },
  };
}

/** Frames every 16 ms from `from` to `to`, writing scrollTo back. */
function run(i: FlowInput, y0: number, from: number, to: number): number {
  let y = y0;
  for (let now = from; now <= to; now += 16) {
    const f = i.frame(y, now);
    if (f.scrollTo !== null) y = f.scrollTo;
  }
  return y;
}

describe('flow input: entering the focus by scroll', () => {
  it('a down notch at the row focuses the centred pack and lands on Front in 1.5 s', () => {
    const p = page();
    expect(p.input.wheel(100, 0, false, 0, 0)).toBe(true);
    expect(p.calls).toEqual(['enter']);
    expect(p.input.frame(0, 750).scrollTo).toBeCloseTo(875, 6);
    expect(run(p.input, 875, 766, 1600)).toBe(1000);
  });
});

describe('flow input: a pack that cannot be focused', () => {
  it('swallows the down gesture and nothing moves', () => {
    const p = page(null);
    expect(p.input.wheel(100, 0, false, 0, 0)).toBe(true);
    expect(p.calls).toEqual([]);
    expect(run(p.input, 0, 16, 2000)).toBe(0);
  });

  it('a page scrolled into the band some other way goes back to the row', () => {
    const p = page(null);
    // the scrollbar left the page at 1300, then quiet
    expect(run(p.input, 1300, 0, 1800)).toBe(0);
  });
});

describe('flow input: the band reached with no pack focused', () => {
  it('a small native scroll near the row returns to the row unfocused', () => {
    const p = page();
    expect(run(p.input, 0.7, 0, 1000)).toBe(0);
    expect(run(p.input, 40, 1000, 2000)).toBe(0);
    expect(p.calls).toEqual([]);
  });

  it('focuses the centred pack and rests on the nearest stop', () => {
    const p = page();
    const y = run(p.input, 2900, 0, 1200);
    expect(p.calls[0]).toBe('enter');
    expect(y).toBe(3000);
  });
});

describe('flow input: touch', () => {
  it('a swipe at the row enters, and a touch during the move is ignored', () => {
    const p = page();
    p.input.touchStart(200, 600, 0, 0);
    expect(p.input.touchMove(200, 560, 0, 16)).toBe(true);
    p.input.touchEnd(0, 32);
    expect(p.calls).toEqual(['enter']);
    let y = run(p.input, 0, 48, 400);
    // a second swipe, upwards, mid-move
    p.input.touchStart(200, 300, y, 416);
    p.input.touchMove(200, 400, y, 432);
    p.input.touchEnd(y, 448);
    y = run(p.input, y, 464, 1700);
    expect(y).toBe(1000);
  });

  it("a sideways touch on the row at rest is the row's own", () => {
    const p = page();
    p.input.touchStart(300, 400, 0, 0, { strip: true });
    expect(p.input.touchMove(200, 402, 0, 16)).toBe(false);
  });

  it("a touch that starts in the free part is the browser's own", () => {
    const p = page();
    p.input.touchStart(200, 600, 9000, 0);
    expect(p.input.touchMove(200, 500, 9000, 16)).toBe(false);
  });
});

describe('flow input: the snap invariant', () => {
  it('a focused page left off a rest glides to the nearest after 150 ms quiet, in 600 ms', () => {
    const p = page();
    p.input.wheel(100, 0, false, 0, 0);
    let y = run(p.input, 0, 16, 1600);
    expect(y).toBe(1000);
    y = 1300; // the scrollbar
    expect(p.input.frame(y, 1700).scrollTo).toBeNull();
    expect(p.input.frame(y, 1840).scrollTo).toBeNull();
    const f = p.input.frame(y, 1860);
    expect(f.animating).toBe(true);
    expect(run(p.input, y, 1876, 1860 + 616)).toBe(1000);
  });
});

describe('flow input: Closing to the free part', () => {
  /** Focused and resting on Closing (6000). */
  function atClosing() {
    const p = page();
    p.input.wheel(100, 0, false, 0, 0);
    let y = run(p.input, 0, 16, 1600);
    y = 6000;
    p.input.frame(y, 1700);
    p.input.frame(y, 1716);
    return { ...p, y };
  }

  it('the stop list ends at Closing', () => {
    const p = atClosing();
    expect(p.input.stops()).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000]);
  });

  it('a down notch at Closing pages in 1.5 s to the end of the Exit spacer, fading the pack out with the scroll by the top of the Exit spacer', () => {
    const p = atClosing();
    p.input.wheel(100, 0, false, p.y, 2000);
    // the pack is gone by the Exit spacer's top (8000), before the free
    // content can come into view
    const early = p.input.frame(p.y, 2250);
    const e = 1 - (1 - 250 / 1500) ** 3;
    expect(early.scrollTo).toBeCloseTo(6000 + 3000 * e, 6);
    expect(early.fade).toBeCloseTo((3000 * e) / 2000, 6);
    const mid = p.input.frame(early.scrollTo ?? 0, 2750);
    expect(mid.scrollTo).toBeCloseTo(6000 + 3000 * 0.875, 6);
    expect(mid.fade).toBe(1);
    expect(mid.focus).toBe(6);
    const y = run(p.input, mid.scrollTo ?? 0, 2766, 3600);
    expect(y).toBe(9000);
    const rest = p.input.frame(y, 3616);
    expect(rest.zone).toBe('free');
    expect(rest.fade).toBe(1);
    // and it stays there (the landing is not snapped back to Closing)
    expect(run(p.input, y, 3632, 5000)).toBe(9000);
  });

  it('the fade is 0 at every stop', () => {
    const p = atClosing();
    expect(p.input.frame(6000, 1800).fade).toBe(0);
    expect(p.input.frame(3000, 1816).fade).toBe(0);
  });

  it('an up notch in the free part that crosses the edge pages back to Closing', () => {
    const p = atClosing();
    // native wheel down in the free part is the browser's
    expect(p.input.wheel(100, 0, false, 9000, 2000)).toBe(false);
    expect(p.input.wheel(-100, 0, false, 7560, 2400)).toBe(true);
    expect(run(p.input, 7560, 2416, 4000)).toBe(6000);
  });
});

describe('flow input: a re-measure keeps P', () => {
  it('a page resting on a stop stays on that stop with a new panel height', () => {
    const p = page();
    p.input.wheel(100, 0, false, 0, 0);
    const y = run(p.input, 0, 16, 1600);
    expect(y).toBe(1000);
    expect(p.input.measure({ ...GEO, panel: 400 }, y)).toBe(500);
  });
});
