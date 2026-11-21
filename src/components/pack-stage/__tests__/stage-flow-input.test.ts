import { describe, expect, it } from 'vitest';

import {
  createFlowInput,
  flowKeyIntent,
  flowLoadStart,
  type FlowInput,
} from '../stage-flow-input';
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
    // the lineup holds through its own section, then the exit plays
    const hold = p.input.frame(y, 3850);
    expect(hold.handoff).toBe(1);
    expect(hold.exit).toBe(0);
    y = run(p.input, y, 3866, 4400);
    const mid = p.input.frame(y, 4416);
    expect(mid.exit).toBeCloseTo(
      Math.max(0, ((mid.scrollTo ?? y) - 8000) / 1000),
      6,
    );
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

describe('flow input: a re-measure keeps P', () => {
  it('a page resting on a stop stays on that stop with a new panel height', () => {
    const p = page();
    p.input.wheel(100, 0, false, 0, 0);
    const y = run(p.input, 0, 16, 1600);
    expect(y).toBe(1000);
    expect(p.input.measure({ ...GEO, panel: 400 }, y)).toBe(500);
  });
});

describe('flow input: keys (plan 2.10)', () => {
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
    expect(flowKeyIntent(ev('ArrowLeft'))).toBeNull();
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

  it('end at the row focuses the centred pack and pages to the lineup (plan 2.10)', () => {
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

  it("in the free part every key is the browser's own", () => {
    const p = atStop(6);
    for (const k of ['next', 'prev', 'first', 'last', 'escape'] as const)
      expect(p.input.key(k, 9000, 2000)).toBe('free');
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

describe('flow load start (plan 2.8: a reload starts at the row)', () => {
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

describe('flow input: a touch during a move across the paged edge (review finding 3)', () => {
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
    p.input.touchStart(200, 600, y, 4710);
    expect(p.input.touchMove(200, 500, y, 4726)).toBe(true);
    p.input.touchEnd(y, 4742);
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
    p.input.touchStart(200, 300, y, 5910);
    expect(p.input.touchMove(200, 400, y, 5926)).toBe(true);
    p.input.touchEnd(y, 5942);
    expect(run(p.input, y, 5958, 7500)).toBe(7000);
  });
});

describe('flow input: a touch that is dropped (review finding 2)', () => {
  it('a cancelled touch leaves the snap and the idle report as they were', () => {
    const p = page();
    p.input.wheel(100, 0, false, 0, 0);
    let y = run(p.input, 0, 16, 1600);
    expect(y).toBe(1000);
    // a finger lands, then its tracking is dropped (a second finger, say)
    p.input.touchStart(200, 600, y, 1700);
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
    p.input.touchStart(200, 600, 9000, 0);
    p.input.touchCancel();
    expect(p.input.frame(9000, 16).idle).toBe(true);
  });
});

describe('flow input: a down gesture refused at the row (review finding 1)', () => {
  it('says so after a down notch, a swipe or a next key with no focusable pack yet', () => {
    const p = page(null);
    expect(p.input.wheel(100, 0, false, 0, 0)).toBe(true);
    expect(p.input.refused()).toBe(true);
    p.input.touchStart(200, 600, 0, 3000);
    p.input.touchMove(200, 500, 0, 3016);
    p.input.touchEnd(0, 3032);
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
