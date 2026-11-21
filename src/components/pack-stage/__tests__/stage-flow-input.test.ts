import { describe, expect, it } from 'vitest';

import {
  createFlowInput,
  flowKeyIntent,
  flowLoadStart,
  type FlowInput,
} from '../stage-flow-input';
import { focusStops } from '../stage-focus-keys';

// panel 800: S = 1000; rests 1000..6000, RL 7000, edge 7500, exit 7000 to 9000
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
    p.input.touchStart(200, 600, 0, 0, 0);
    expect(p.input.touchMove(200, 560, 0, 16, 16)).toBe(true);
    p.input.touchEnd(0, 32, 32);
    expect(p.calls).toEqual(['enter']);
    let y = run(p.input, 0, 48, 400);
    // a second swipe, upwards, mid-move
    p.input.touchStart(200, 300, y, 416, 416);
    p.input.touchMove(200, 400, y, 432, 432);
    p.input.touchEnd(y, 448, 448);
    y = run(p.input, y, 464, 1700);
    expect(y).toBe(1000);
  });

  it("a sideways touch on the row at rest is the row's own", () => {
    const p = page();
    p.input.touchStart(300, 400, 0, 0, 0, { strip: true });
    expect(p.input.touchMove(200, 402, 0, 16, 16)).toBe(false);
  });

  it("a vertical touch in the free part is the flow's: the page follows the finger 1:1; a sideways one stays the browser's", () => {
    const p = page();
    p.input.touchStart(200, 600, 9000, 0, 0);
    expect(p.input.touchMove(200, 500, 9000, 16, 16)).toBe(true);
    expect(p.input.follow()).toBe(9100);
    expect(p.input.follow()).toBeNull(); // read once
    p.input.touchEnd(9100, 32, 32);
    p.input.touchStart(200, 600, 9100, 100, 100);
    expect(p.input.touchMove(100, 598, 9100, 116, 116)).toBe(false);
    expect(p.input.follow()).toBeNull();
  });

  it('a free flick glides on after the release (sign * |v|^1.7)', () => {
    const p = page();
    let y = 9000;
    p.input.touchStart(200, 600, y, 0, 0);
    p.input.frame(y, 0);
    for (let i = 1; i <= 3; i++) {
      p.input.touchMove(200, 600 - 32 * i, y, i * 16, i * 16);
      y = p.input.follow() ?? y;
      p.input.frame(y, i * 16);
    }
    expect(y).toBe(9096);
    p.input.touchEnd(y, 50, 50);
    const end = run(p.input, y, 64, 3000);
    expect(end).toBeGreaterThan(9096 + 300);
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

  it('the stop list ends at the lineup rest', () => {
    const p = atClosing();
    expect(p.input.stops()).toEqual([
      0, 1000, 2000, 3000, 4000, 5000, 6000, 7000,
    ]);
  });

  it('a pack that cannot be focused keeps the row alone (no lineup to rest on)', () => {
    const p = page(null);
    expect(p.input.stops()).toEqual([0]);
    // the scrollbar left the page near the lineup: back to the row, unfocused
    expect(run(p.input, 6900, 0, 1800)).toBe(0);
    expect(p.input.frame(0, 1816).handoff).toBe(0);
  });

  it('a down notch at Closing pages in 1.5 s to the lineup rest, the hand-off following the scroll', () => {
    const p = atClosing();
    p.input.wheel(100, 0, false, p.y, 2000);
    const early = p.input.frame(p.y, 2250);
    const e = 1 - (1 - 250 / 1500) ** 3;
    expect(early.scrollTo).toBeCloseTo(6000 + 1000 * e, 6);
    // the local progress from Closing to the lineup (eased by the pose)
    expect(early.handoff).toBeCloseTo(e, 6);
    expect(early.exit).toBe(0);
    expect(early.focus).toBe(6);
    const y = run(p.input, early.scrollTo ?? 0, 2266, 3600);
    expect(y).toBe(7000);
    const rest = p.input.frame(y, 3616);
    expect(rest.zone).toBe('paged');
    expect(rest.handoff).toBe(1);
    expect(rest.exit).toBe(0);
    expect(rest.past).toBe(true);
    // a rest: it stays there
    expect(run(p.input, y, 3632, 5000)).toBe(7000);
  });

  it('a down notch at the lineup pages in 1.5 s through the exit to the free part', () => {
    const p = atClosing();
    p.input.wheel(100, 0, false, p.y, 2000);
    let y = run(p.input, p.y, 2016, 3600);
    expect(y).toBe(7000);
    p.input.wheel(100, 0, false, y, 3800);
    // the exit starts on the move's first frame, over both sections
    const first = p.input.frame(y, 3816);
    expect(first.handoff).toBe(1);
    expect(first.scrollTo).toBeGreaterThan(7000);
    expect(first.exit).toBeGreaterThan(0);
    expect(first.exit).toBeCloseTo(((first.scrollTo ?? y) - 7000) / 2000, 6);
    y = run(p.input, first.scrollTo ?? y, 3832, 4400);
    const mid = p.input.frame(y, 4416);
    expect(mid.exit).toBeCloseTo(((mid.scrollTo ?? y) - 7000) / 2000, 6);
    y = run(p.input, mid.scrollTo ?? y, 4432, 5400);
    expect(y).toBe(9000);
    const free = p.input.frame(y, 5416);
    expect(free.zone).toBe('free');
    expect([free.handoff, free.exit]).toEqual([1, 1]);
  });

  it('the hand-off and the exit are 0 at every detail stop', () => {
    const p = atClosing();
    for (const y of [6000, 3000, 1000]) {
      const f = p.input.frame(y, 1800 + y / 100);
      expect([f.handoff, f.exit], String(y)).toEqual([0, 0]);
    }
  });

  it('an up notch in the free part that crosses the edge pages back to the lineup, and the next one to Closing', () => {
    const p = atClosing();
    // native wheel down in the free part is the browser's
    expect(p.input.wheel(100, 0, false, 9000, 2000)).toBe(false);
    expect(p.input.wheel(-100, 0, false, 7560, 2400)).toBe(true);
    const y = run(p.input, 7560, 2416, 4000);
    expect(y).toBe(7000);
    expect(p.input.wheel(-100, 0, false, y, 4200)).toBe(true);
    expect(run(p.input, y, 4216, 5800)).toBe(6000);
  });

  it('a page the browser left between the lineup and the edge snaps to the lineup', () => {
    const p = atClosing();
    expect(run(p.input, 7480, 2000, 3200)).toBe(7000);
  });
});

describe('flow input: the wrap', () => {
  const FULL = {
    ...GEO,
    telegram: { top: 11000, bottom: 12000 },
    ret: { top: 12000, height: 1000 },
    last: { top: 13000, height: 801 },
  };

  it('the geometry carries the rise, Return and Last into the table', () => {
    const p = page();
    p.input.measure(FULL, 0);
    const t = p.input.table()!;
    expect(t.rise).toEqual({ start: 11000 - 0.35 * 800, end: 12000 });
    expect(t.ret).toEqual({ start: 12000, end: 13000 });
    expect(t.lastTop).toBe(13000);
  });

  it('a scroll across Last wraps; the wrap frame says so; nothing is focused during the lock, however far it overshot', () => {
    const p = page();
    p.input.measure(FULL, 0);
    p.input.frame(12990, 0);
    const f = p.input.frame(13700, 16);
    expect(f.wrap).toBe(0);
    expect(f.lock).toBe('wrap');
    expect(f.scrollTo).toBe(700);
    expect(run(p.input, 700, 32, 1300)).toBe(0);
    expect(p.calls).toEqual([]);
  });

  it('a gesture during the lock is swallowed and focuses nothing', () => {
    const p = page();
    p.input.measure(FULL, 0);
    p.input.frame(12990, 0);
    let y = p.input.frame(13030, 16).scrollTo!;
    expect(p.input.wheel(100, 0, false, y, 100)).toBe(true);
    p.input.touchStart(200, 600, y, 120, 120);
    p.input.touchMove(200, 400, y, 136, 136);
    p.input.touchEnd(y, 150, 150);
    expect(p.input.key('next', y, 160)).toBe('swallowed');
    y = run(p.input, y, 32, 1400);
    expect(y).toBe(0);
    expect(p.calls).toEqual([]);
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

  // the browser lays the shorter page out and clamps the scroll before the
  // resize listener runs: the place comes from the last frame, not from it
  const geoAt = (panel: number, k: number) => ({
    ...GEO,
    panel,
    viewport: panel,
    telegram: { top: 11000 * k, bottom: 12000 * k },
    ret: { top: 12000 * k, height: 1000 * k },
    last: { top: 13000 * k, height: 801 },
    sections: [
      { top: 9000 * k, height: 400 * k },
      { top: 9400 * k, height: 1600 * k },
      { top: 11000 * k, height: 1000 * k },
      { top: 12000 * k, height: 1000 * k },
      { top: 13000 * k, height: 801 },
    ],
  });

  it('keeps the place of the last frame when the scroll handed in is already clamped (lineup, Closing)', () => {
    for (const [stop, want] of [
      [7000, 3500],
      [6000, 3000],
    ] as const) {
      const p = page();
      p.input.measure(geoAt(800, 1), 0);
      p.input.goTo(stop / 1000, 0, 0);
      const y = run(p.input, 0, 16, 1700);
      expect(y).toBe(stop);
      // rotated: half the panel; the browser already clamped the scroll
      expect(p.input.measure(geoAt(400, 0.5), 2900)).toBe(want);
    }
  });

  it('keeps the section under the middle in the free part, even when clamped, and writes it', () => {
    const p = page();
    p.input.measure(geoAt(800, 1), 0);
    p.input.frame(9800, 0); // Just Pulled under the middle, at (10200 - 9400) / 1600
    const y = p.input.measure(geoAt(400, 0.5), 4100);
    expect(y).not.toBeNull();
    expect(y! + 200).toBeCloseTo(4700 + 800 * 0.5, 6);
  });

  it('a content-only change (Just Pulled grows, same viewport and panel) leaves the free part where it is', () => {
    const p = page();
    p.input.measure(geoAt(800, 1), 0);
    p.input.frame(9800, 0);
    const grown = geoAt(800, 1);
    grown.sections = grown.sections.map((s, i) =>
      i === 1
        ? { ...s, height: s.height + 300 }
        : i > 1
          ? { ...s, top: s.top + 300 }
          : s,
    );
    expect(p.input.measure(grown, 9800)).toBeNull();
  });

  it('P makes the round trip across a re-measure in every zone', () => {
    for (const y0 of [0, 3000, 6000, 7000, 8000, 9800, 10900, 11500, 12500]) {
      const p = page();
      p.input.measure(geoAt(800, 1), 0);
      p.input.frame(y0, 0);
      const y1 = p.input.measure(geoAt(400, 0.5), y0 / 2) ?? y0 / 2;
      p.input.frame(y1, 16);
      const y2 = p.input.measure(geoAt(800, 1), y1) ?? y1;
      expect(y2, String(y0)).toBeCloseTo(y0, 3);
    }
  });
});

describe('flow input: keys', () => {
  const ev = (
    key: string,
    o: Partial<
      Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>
    > = {},
  ) => ({
    key,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...o,
  });

  it('maps the keys to one intent each', () => {
    expect(flowKeyIntent(ev('ArrowDown'))).toBe('next');
    expect(flowKeyIntent(ev('PageDown'))).toBe('next');
    expect(flowKeyIntent(ev(' '))).toBe('next');
    expect(flowKeyIntent(ev(' ', { shiftKey: true }))).toBe('prev');
    expect(flowKeyIntent(ev('ArrowUp'))).toBe('prev');
    expect(flowKeyIntent(ev('PageUp'))).toBe('prev');
    expect(flowKeyIntent(ev('Home'))).toBe('first');
    expect(flowKeyIntent(ev('End'))).toBe('last');
    expect(flowKeyIntent(ev('Escape'))).toBe('escape');
    // the lineup's pick; elsewhere the flow returns them
    expect(flowKeyIntent(ev('ArrowLeft'))).toBe('left');
    expect(flowKeyIntent(ev('ArrowRight'))).toBe('right');
    expect(flowKeyIntent(ev('Tab'))).toBeNull();
    expect(flowKeyIntent(ev('ArrowDown', { ctrlKey: true }))).toBeNull();
    expect(flowKeyIntent(ev('End', { metaKey: true }))).toBeNull();
    expect(flowKeyIntent(ev('Home', { altKey: true }))).toBeNull();
  });

  /** Focused and resting on stop k. */
  function atStop(k: number) {
    const p = page();
    p.input.key('next', 0, 0);
    let y = run(p.input, 0, 16, 1600);
    y = k * 1000;
    p.input.frame(y, 1700);
    p.input.frame(y, 1716);
    return { ...p, y };
  }

  it('next at the row focuses the centred pack and lands on Front in 1.5 s', () => {
    const p = page();
    expect(p.input.key('next', 0, 0)).toBe('moved');
    expect(p.calls).toEqual(['enter']);
    expect(p.input.frame(0, 750).scrollTo).toBeCloseTo(875, 6);
    expect(run(p.input, 875, 766, 1600)).toBe(1000);
  });

  it('next at the row with a pack that cannot be focused is swallowed, and nothing moves', () => {
    const p = page(null);
    expect(p.input.key('next', 0, 0)).toBe('swallowed');
    expect(p.calls).toEqual([]);
    expect(run(p.input, 0, 16, 2000)).toBe(0);
  });

  it('prev, first and escape at the row do nothing (prev and first are swallowed, escape is free)', () => {
    const p = page();
    expect(p.input.key('prev', 0, 0)).toBe('swallowed');
    expect(p.input.key('first', 0, 0)).toBe('swallowed');
    expect(p.input.key('escape', 0, 0)).toBe('free');
    expect(run(p.input, 0, 16, 2000)).toBe(0);
  });

  it('end at the row focuses the centred pack and pages to the lineup', () => {
    const p = page();
    expect(p.input.key('last', 0, 0)).toBe('moved');
    expect(p.calls).toEqual(['enter']);
    expect(run(p.input, 0, 16, 1600)).toBe(7000);
  });

  it('next and prev page one stop either way between the stops', () => {
    const p = atStop(2);
    expect(p.input.key('next', p.y, 2000)).toBe('moved');
    let y = run(p.input, p.y, 2016, 3600);
    expect(y).toBe(3000);
    expect(p.input.key('prev', y, 3700)).toBe('moved');
    y = run(p.input, y, 3716, 5300);
    expect(y).toBe(2000);
  });

  it('end pages to the lineup, from any stop', () => {
    const p = atStop(2);
    expect(p.input.key('last', p.y, 2000)).toBe('moved');
    expect(run(p.input, p.y, 2016, 3600)).toBe(7000);
  });

  it('prev at Front, home at any stop and escape in the details hand over to the leave', () => {
    expect(atStop(1).input.key('prev', 1000, 2000)).toBe('leave');
    const p = atStop(3);
    expect(p.input.key('first', p.y, 2000)).toBe('leave');
    expect(p.input.key('escape', p.y, 2000)).toBe('leave');
  });

  it('next at Closing pages on to the lineup, and next there to the free part, as wheel notches do', () => {
    const p = atStop(6);
    expect(p.input.key('next', p.y, 2000)).toBe('moved');
    const y = run(p.input, p.y, 2016, 3600);
    expect(y).toBe(7000);
    expect(p.input.key('next', y, 3700)).toBe('moved');
    expect(run(p.input, y, 3716, 5300)).toBe(9000);
  });

  it('prev at the lineup pages back up to Closing', () => {
    const p = atStop(7);
    expect(p.input.key('prev', p.y, 2000)).toBe('moved');
    expect(run(p.input, p.y, 2016, 3600)).toBe(6000);
  });

  it('keys during a move are swallowed', () => {
    const p = atStop(2);
    p.input.key('next', p.y, 2000);
    const y = run(p.input, p.y, 2016, 2400);
    for (const k of ['next', 'prev', 'first', 'last', 'escape'] as const)
      expect(p.input.key(k, y, 2420)).toBe('swallowed');
    expect(run(p.input, y, 2416, 3600)).toBe(3000);
  });

  it("home and escape at the lineup go back to the row by the wrap's lock (1.2 s), entering nothing", () => {
    for (const k of ['first', 'escape'] as const) {
      const p = atStop(7);
      expect(p.input.key(k, p.y, 2000)).toBe('moved');
      const f = p.input.frame(p.y, 2016);
      expect(f.lock).toBe('home');
      expect(f.wrap).toBe(0);
      expect(run(p.input, p.y, 2032, 2016 + 1216)).toBe(0);
      expect(p.calls).toEqual(['enter']);
    }
  });

  it("in the free part every key is the browser's own", () => {
    const p = atStop(6);
    for (const k of ['next', 'prev', 'first', 'last', 'escape'] as const)
      expect(p.input.key(k, 9000, 2000)).toBe('free');
  });
});

describe('flow input: End at the row with a pack that cannot be focused', () => {
  it('is swallowed, nothing is entered and nothing moves', () => {
    const p = page(null);
    expect(p.input.key('last', 0, 0)).toBe('swallowed');
    expect(p.calls).toEqual([]);
    expect(p.input.busy()).toBe(false);
    expect(run(p.input, 0, 16, 2000)).toBe(0);
  });
});

describe('flow input: a held key', () => {
  /** Focused and resting on Closing (6000). */
  function atClosing() {
    const p = page();
    p.input.wheel(100, 0, false, 0, 0);
    run(p.input, 0, 16, 1600);
    const y = 6000;
    p.input.frame(y, 1700);
    p.input.frame(y, 1716);
    return { ...p, y };
  }

  it('a repeated paging key moves nothing in the paged part, and is still cancelled there', () => {
    const p = atClosing();
    for (const k of ['next', 'prev', 'first', 'last'] as const)
      expect(p.input.key(k, p.y, 2000, true), k).toBe('swallowed');
    expect(p.input.busy()).toBe(false);
    // at the row too: a held key never enters
    const r = page();
    expect(r.input.key('next', 0, 0, true)).toBe('swallowed');
    expect(r.input.busy()).toBe(false);
  });

  it('in the free part a repeated key is the browser own', () => {
    const p = atClosing();
    expect(p.input.key('next', 9000, 2000, true)).toBe('free');
  });

  it('the first press still pages', () => {
    const p = atClosing();
    expect(p.input.key('next', p.y, 2000, false)).toBe('moved');
  });
});

describe('flow input: past the details (the address threshold)', () => {
  it('switches where the text does: 20% into the move below Closing, either way', () => {
    const p = page();
    p.input.key('next', 0, 0);
    run(p.input, 0, 16, 1600);
    expect(p.input.frame(6000, 2000).past).toBe(false);
    expect(p.input.frame(6190, 2016).past).toBe(false);
    expect(p.input.frame(6200, 2032).past).toBe(true);
    expect(p.input.frame(7400, 2048).past).toBe(true);
    // and on the way back up the same line
    expect(p.input.frame(6210, 2064).past).toBe(true);
    expect(p.input.frame(6190, 2080).past).toBe(false);
  });

  it('is true in the free part and false at every stop', () => {
    const p = page();
    p.input.key('next', 0, 0);
    run(p.input, 0, 16, 1600);
    expect(p.input.frame(9000, 2000).past).toBe(true);
    for (const y of [1000, 2000, 3000, 4000, 5000, 6000])
      expect(p.input.frame(y, 2016 + y / 100).past).toBe(false);
  });
});

describe('flow load start', () => {
  it('a reload or a history load starts at R0', () => {
    expect(flowLoadStart('reload', 9300, 0)).toBe(0);
    expect(flowLoadStart('back_forward', 2000, 0)).toBe(0);
    expect(flowLoadStart('reload', 9300, 56)).toBe(56);
  });

  it('a plain load, or a page already at R0, is left alone', () => {
    expect(flowLoadStart('navigate', 400, 0)).toBeNull();
    expect(flowLoadStart('reload', 0, 0)).toBeNull();
    expect(flowLoadStart(undefined, 400, 0)).toBeNull();
  });
});

describe('flow input: a touch during a move across the paged edge', () => {
  /** Focused and resting on the lineup (7000). */
  function lineup() {
    const p = page();
    p.input.wheel(100, 0, false, 0, 0);
    run(p.input, 0, 16, 1600);
    p.input.frame(6000, 1700);
    p.input.frame(6000, 1716);
    p.input.wheel(100, 0, false, 6000, 2000);
    expect(run(p.input, 6000, 2016, 3600)).toBe(7000);
    return p;
  }

  it('a finger that lands past the edge on the way down is ignored: the move lands on the exit end', () => {
    const p = lineup();
    p.input.wheel(100, 0, false, 7000, 3800);
    // 0.9 s in: past the edge (7500), the move still running
    const y = run(p.input, 7000, 3816, 4700);
    expect(y).toBeGreaterThan(7500);
    p.input.touchStart(200, 600, y, 4710, 4710);
    expect(p.input.touchMove(200, 500, y, 4726, 4726)).toBe(true);
    p.input.touchEnd(y, 4742, 4742);
    expect(run(p.input, y, 4758, 5800)).toBe(9000);
  });

  it('a finger that lands past the edge on the way back up is ignored: the move lands on the lineup', () => {
    const p = lineup();
    p.input.wheel(100, 0, false, 7000, 3800);
    let y = run(p.input, 7000, 3816, 5400);
    expect(y).toBe(9000);
    // the browser's own scroll up to just below the edge, then an up notch
    // that crosses it pages back to the lineup
    y = run(p.input, 7560, 5416, 5700);
    expect(y).toBe(7560);
    expect(p.input.wheel(-100, 0, false, 7560, 5800)).toBe(true);
    // the first frame of the move: still below the edge
    y = run(p.input, 7560, 5804, 5804);
    expect(y).toBeGreaterThan(7500);
    p.input.touchStart(200, 300, y, 5910, 5910);
    expect(p.input.touchMove(200, 400, y, 5926, 5926)).toBe(true);
    p.input.touchEnd(y, 5942, 5942);
    expect(run(p.input, y, 5958, 7500)).toBe(7000);
  });
});

describe('flow input: a touch that is dropped', () => {
  it('a cancelled touch leaves the snap and the idle report as they were', () => {
    const p = page();
    p.input.wheel(100, 0, false, 0, 0);
    let y = run(p.input, 0, 16, 1600);
    expect(y).toBe(1000);
    // a finger lands, then its tracking is dropped (a second finger, say)
    p.input.touchStart(200, 600, y, 1700, 1700);
    p.input.touchCancel();
    // a pinch left the page off its rest
    y = 1180;
    expect(p.input.frame(y, 1716).idle).toBe(false);
    y = run(p.input, y, 1732, 2700);
    expect(y).toBe(1000);
    expect(p.input.frame(y, 2716).idle).toBe(true);
  });

  it('a cancelled touch in the free part hands the frame back to the pager', () => {
    const p = page();
    p.input.touchStart(200, 600, 9000, 0, 0);
    p.input.touchCancel();
    expect(p.input.frame(9000, 16).idle).toBe(true);
  });
});

describe('flow input: a down gesture refused at the row', () => {
  it('says so after a down notch, a swipe or a next key with no focusable pack yet', () => {
    const p = page(null);
    expect(p.input.wheel(100, 0, false, 0, 0)).toBe(true);
    expect(p.input.refused()).toBe(true);
    p.input.touchStart(200, 600, 0, 3000, 3000);
    p.input.touchMove(200, 500, 0, 3016, 3016);
    p.input.touchEnd(0, 3032, 3032);
    expect(p.input.refused()).toBe(true);
    expect(p.input.key('next', 0, 6000)).toBe('swallowed');
    expect(p.input.refused()).toBe(true);
  });

  it('an up notch, a small notch, or a focusable pack is not a refusal', () => {
    const p = page(null);
    p.input.wheel(100, 0, false, 0, 0);
    p.input.wheel(-100, 0, false, 0, 3000);
    expect(p.input.refused()).toBe(false);
    p.input.wheel(2, 0, false, 0, 6000);
    expect(p.input.refused()).toBe(false);
    const q = page();
    q.input.wheel(100, 0, false, 0, 0);
    expect(q.input.refused()).toBe(false);
  });
});

describe('flow input: the endless pick at the lineup', () => {
  const CAPSULE = focusStops('capsule');
  /**
   * Focused on pack 2 of 5 and resting on the lineup (7000). `kindsOf`
   * gives each pack's stops (default: all sleeves). The row's track follows
   * the line's frames, as the spin chunk writes it.
   */
  function lineup(kindsOf: (i: number) => readonly string[] = () => SLEEVE) {
    let on = false;
    let index = 2;
    let track = 2;
    let refuse = false;
    const picks: number[] = [];
    const input = createFlowInput({
      centreKinds: () => kindsOf(index),
      focused: () => on,
      kinds: () => (on ? kindsOf(index) : []),
      enter: () => {
        on = true;
        return true;
      },
      line: () => (on ? { track, count: 5, index } : null),
      pick: (i) => {
        picks.push(i);
        if (refuse) return false;
        index = i;
        return true;
      },
      canPick: () => true,
    });
    input.measure(GEO, 0);
    const go = (y0: number, from: number, to: number): number => {
      let y = y0;
      for (let now = from; now <= to; now += 16) {
        const f = input.frame(y, now);
        if (f.scrollTo !== null) y = f.scrollTo;
        if (f.line) track = f.line.track;
      }
      return y;
    };
    input.wheel(100, 0, false, 0, 0);
    go(0, 16, 1600);
    input.key('last', 1000, 1700);
    expect(go(1000, 1716, 3400)).toBe(7000);
    return {
      input,
      picks,
      go,
      track: () => track,
      index: () => index,
      /** Another pack focused by other means (a new focus at the row). */
      refocus(i: number) {
        index = i;
        track = i;
      },
      refuse() {
        refuse = true;
      },
      /** A swipe of (dx, dy) px from (200, 600) at 16 ms per move, then the release. */
      swipe(dx: number, dy: number, y: number, t0: number) {
        input.touchStart(200, 600, y, t0, t0);
        let consumed = true;
        for (let k = 1; k <= 8; k++) {
          const c = input.touchMove(
            200 + (dx * k) / 8,
            600 + (dy * k) / 8,
            y,
            t0 + 16 * k,
            t0 + 16 * k,
          );
          consumed = consumed && c;
          const f = input.frame(y, t0 + 16 * k);
          if (f.line) track = f.line.track;
        }
        // held still a moment: no fling
        for (let k = 9; k <= 16; k++) {
          const f = input.frame(y, t0 + 16 * k);
          if (f.line) track = f.line.track;
        }
        input.touchEnd(y, t0 + 16 * 17, t0 + 16 * 17);
        return consumed;
      },
    };
  }

  it('a sideways swipe at 46 degrees from vertical drags the row and leaves the page on the lineup', () => {
    const p = lineup();
    const a = (46 * Math.PI) / 180;
    // finger left and up: two packs on, the page stays
    expect(p.swipe(-200, (-200 * Math.cos(a)) / Math.sin(a), 7000, 4000)).toBe(
      true,
    );
    const y = p.go(7000, 4300, 6000);
    expect(y).toBe(7000);
    expect(p.track()).toBe(4);
  });

  it('at 44 degrees from vertical the same swipe pages (to the free part) and the row stays', () => {
    const p = lineup();
    const a = (44 * Math.PI) / 180;
    p.swipe(-150, (-150 * Math.cos(a)) / Math.sin(a), 7000, 4000);
    expect(p.go(7000, 4300, 6500)).toBe(9000);
    expect(p.track()).toBe(2);
    expect(p.picks).toEqual([]);
  });

  it('the pick is carried 150 ms after the row comes to rest, not before', () => {
    const p = lineup();
    p.swipe(-100, 0, 7000, 4000);
    // the row eases onto pack 3; no pick while it moves
    let now = 4300;
    for (; now < 6000; now += 16) {
      const f = p.input.frame(7000, now);
      if (f.line && !f.line.moving) break;
      expect(p.picks).toEqual([]);
    }
    expect(p.input.frame(7000, now + 100).idle).toBe(false);
    expect(p.picks).toEqual([]);
    p.input.frame(7000, now + 160);
    expect(p.picks).toEqual([3]);
    expect(p.input.frame(7000, now + 200).idle).toBe(true);
  });

  it('wraps across the row: from the last pack one on is the first', () => {
    const p = lineup();
    p.swipe(-200, 0, 7000, 4000);
    p.go(7000, 4300, 6000);
    expect(p.picks).toEqual([4]);
    p.swipe(-100, 0, 7000, 7000);
    p.go(7000, 7300, 9000);
    expect(p.picks).toEqual([4, 0]);
    expect(p.track()).toBe(0);
  });

  it('an up gesture with a pick pending carries it at once, before the page moves', () => {
    const p = lineup();
    p.swipe(-100, 0, 7000, 4000);
    // still easing onto pack 3
    p.go(7000, 4300, 4350);
    expect(p.picks).toEqual([]);
    expect(p.input.wheel(-100, 0, false, 7000, 4400)).toBe(true);
    expect(p.picks).toEqual([3]);
    expect(p.go(7000, 4416, 6000)).toBe(6000);
    // the row finished its ease on the way
    expect(p.track()).toBe(3);
  });

  it('a pick that changes the stop list (a capsule) leaves the lineup where it was; up lands on its Closing', () => {
    const p = lineup((i) => (i === 3 ? CAPSULE : SLEEVE));
    p.swipe(-100, 0, 7000, 4000);
    p.go(7000, 4300, 6000);
    expect(p.picks).toEqual([3]);
    expect(p.input.table()!.rl).toBe(7000);
    expect(p.input.stops()).toHaveLength(CAPSULE.length + 2);
    expect(p.go(7000, 6016, 6500)).toBe(7000);
    p.input.wheel(-100, 0, false, 7000, 7000);
    expect(p.go(7000, 7016, 8700)).toBe(6000);
  });

  it("ArrowLeft and ArrowRight pick only at the lineup; elsewhere they are the browser's", () => {
    const p = lineup();
    expect(p.input.key('right', 7000, 4000)).toBe('moved');
    p.go(7000, 4016, 5000);
    expect(p.picks).toEqual([3]);
    expect(p.input.key('left', 7000, 6000)).toBe('moved');
    expect(p.input.key('left', 7000, 6050)).toBe('moved');
    p.go(7000, 6066, 7000);
    expect(p.picks).toEqual([3, 1]);
    // at Closing and at the row: not ours
    p.input.key('prev', 7000, 8000);
    expect(p.go(7000, 8016, 9700)).toBe(6000);
    expect(p.input.key('right', 6000, 10000)).toBe('free');
    expect(p.input.key('left', 6000, 10100)).toBe('free');
    const q = page();
    expect(q.input.key('right', 0, 0)).toBe('free');
  });

  it('no drag during a vertical move or away from the lineup', () => {
    const p = lineup();
    // a move up to Closing is playing: a sideways swipe is ignored
    p.input.wheel(-100, 0, false, 7000, 4000);
    const y = p.go(7000, 4016, 4300);
    p.swipe(-200, 0, y, 4316);
    expect(p.go(y, 4620, 6000)).toBe(6000);
    expect(p.track()).toBe(2);
    // at Closing a sideways swipe moves nothing
    p.swipe(-200, 0, 6000, 7000);
    p.go(6000, 7300, 8000);
    expect(p.track()).toBe(2);
    expect(p.picks).toEqual([]);
  });

  it('a mouse drag picks on the desktop; a vertical mouse drag does nothing', () => {
    const p = lineup();
    expect(p.input.mouseDown(700, 400, 7000, 4000)).toBe(true);
    for (let k = 1; k <= 8; k++) {
      p.input.mouseMove(700 - 25 * k, 400, 4000 + 16 * k);
      p.go(7000, 4000 + 16 * k, 4000 + 16 * k);
    }
    p.go(7000, 4144, 4300);
    p.input.mouseUp(4310);
    p.go(7000, 4320, 6000);
    expect(p.picks).toEqual([4]);
    expect(p.input.mouseDown(700, 400, 7000, 7000)).toBe(true);
    expect(p.input.mouseMove(702, 300, 7016)).toBe(false);
    p.input.mouseUp(7100);
    expect(p.go(7000, 7116, 8000)).toBe(7000);
    expect(p.picks).toEqual([4]);
    // away from the lineup a press is not ours
    expect(p.input.mouseDown(700, 400, 6000, 9000)).toBe(false);
  });

  it('a sideways wheel at the lineup steps one pack and is consumed; at Closing it is not', () => {
    const p = lineup();
    expect(p.input.wheel(2, 40, false, 7000, 4000)).toBe(true);
    p.go(7000, 4016, 5000);
    expect(p.picks).toEqual([3]);
    expect(p.input.wheel(0, -40, false, 6000, 6000)).toBe(false);
  });

  it('a pick already carried is never carried again once another pack is focused', () => {
    const p = lineup();
    p.swipe(-200, 0, 7000, 4000);
    p.go(7000, 4300, 6000);
    expect(p.picks).toEqual([4]);
    // back to the row and a new focus on pack 1 (by a tap, say)
    p.refocus(1);
    p.go(7000, 6016, 8000);
    expect(p.picks).toEqual([4]);
    expect(p.input.frame(7000, 8016).idle).toBe(true);
  });

  it('a pick that cannot be made is dropped, not tried again and again', () => {
    const p = lineup();
    p.refuse();
    p.swipe(-100, 0, 7000, 4000);
    p.go(7000, 4300, 7000);
    expect(p.picks).toEqual([3]);
    expect(p.input.frame(7000, 7016).idle).toBe(true);
  });

  it('a vertical gesture while the mouse holds the row is swallowed: no page, no pick', () => {
    const p = lineup();
    p.input.mouseDown(700, 400, 7000, 4000);
    p.input.mouseMove(600, 400, 4016);
    p.go(7000, 4016, 4032);
    expect(p.input.wheel(-100, 0, false, 7000, 4050)).toBe(true);
    expect(p.input.key('prev', 7000, 4060)).toBe('swallowed');
    expect(p.go(7000, 4066, 4400)).toBe(7000);
    expect(p.picks).toEqual([]);
    p.input.mouseUp(4410);
    p.go(7000, 4420, 6000);
    expect(p.picks).toEqual([3]);
  });

  it('a cancelled sideways touch still comes to rest on a pack', () => {
    const p = lineup();
    p.input.touchStart(200, 600, 7000, 4000, 4000);
    for (let k = 1; k <= 4; k++) {
      p.input.touchMove(200 - 35 * k, 600, 7000, 4000 + 16 * k, 4000 + 16 * k);
      p.go(7000, 4000 + 16 * k, 4000 + 16 * k);
    }
    p.input.touchCancel();
    p.go(7000, 4100, 6000);
    expect(Number.isInteger(p.track())).toBe(true);
    expect(p.picks).toEqual([3]);
  });
});
