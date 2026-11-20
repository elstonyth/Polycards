import { describe, expect, it } from 'vitest';

import { flowTable, type FlowGeometry } from '../stage-flow';
import {
  GLIDE_LERP,
  GLIDE_POWER,
  SNAP_MS,
  SNAP_QUIET_MS,
  WHEEL_MIN_DELTA,
  createFlowPager,
  flowPagerTable,
  glideDistance,
  type FlowPager,
} from '../stage-flow-pager';
import { focusStops } from '../stage-focus-keys';
import {
  AXIS_LOCK_PX,
  PAGE_MS,
  SAME_FRAMING_MS,
  TOUCH_PAGE_PX,
  WHEEL_GAP_MS,
  createPager,
} from '../stage-pager';

// panel 800: S = 1000; rests 1000..6000, RL 7000, edge 7500, exit end 8000
const GEO: FlowGeometry = {
  top: 0,
  panel: 800,
  stops: 6,
  viewport: 800,
  telegram: { top: 11000, bottom: 12000 },
  ret: { top: 12000, height: 1000 },
  last: { top: 13000, height: 801 },
};
const tableFor = (
  g: Partial<FlowGeometry> = {},
  kinds = focusStops('sleeve'),
) => {
  const t = flowTable({ ...GEO, ...g, stops: kinds.length });
  if (!t) throw new Error('no table');
  return flowPagerTable(t, kinds);
};
const make = (g: Partial<FlowGeometry> = {}, kinds = focusStops('sleeve')) => {
  const p = createFlowPager();
  p.setTable(tableFor(g, kinds));
  return p;
};

/** Runs frames every 16 ms from `from` to `to`, writing scrollTo back. */
function run(p: FlowPager, y0: number, from: number, to: number): number {
  let y = y0;
  for (let now = from; now <= to; now += 16) {
    const f = p.frame(y, now);
    if (f.scrollTo !== null) y = f.scrollTo;
  }
  return y;
}
/** A finger swipe in the paged zone: start, two moves, release. */
function swipe(
  p: FlowPager,
  y: number,
  now: number,
  dx: number,
  dy: number,
  o?: { strip?: boolean },
) {
  p.touchStart(200, 400, y, now, o);
  const a = p.touchMove(200 + dx / 2, 400 + dy / 2, y, now + 16);
  const b = p.touchMove(200 + dx, 400 + dy, y, now + 32);
  p.touchEnd(y, now + 48);
  return [a, b];
}
const fromDeg = (deg: number, len = 80) => {
  const r = (deg * Math.PI) / 180;
  // degrees from vertical; a finger moving up pages down
  return { dx: len * Math.sin(r), dy: -len * Math.cos(r) };
};

describe('flow pager: numbers', () => {
  it('keeps the focus pager rules and the snap', () => {
    expect([
      PAGE_MS,
      SAME_FRAMING_MS,
      WHEEL_GAP_MS,
      AXIS_LOCK_PX,
      TOUCH_PAGE_PX,
    ]).toEqual([1500, 1000, 120, 6, 24]);
    expect(WHEEL_MIN_DELTA).toBe(4);
    expect([SNAP_QUIET_MS, SNAP_MS]).toEqual([150, 600]);
    expect([GLIDE_POWER, GLIDE_LERP]).toEqual([1.7, 0.075]);
  });

  it('the stop list is [R0, rests, RL] with the exit end past it', () => {
    const t = tableFor();
    expect(t.stops).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
    expect(t.exitEnd).toBe(8000);
    expect(t.edge).toBe(7500);
    expect(t.lineup).toBe(true);
    expect(tableFor({}, focusStops('capsule')).stops).toEqual([
      0, 1000, 2250, 3500, 4750, 6000, 7000,
    ]);
    expect(tableFor({}, focusStops('noOdds')).stops).toEqual([
      0, 1000, 2667, 4333, 6000, 7000,
    ]);
  });
});

describe('flow pager: zone', () => {
  it('paged up to RL + S / 2, free below', () => {
    const p = make();
    expect(p.zone(0)).toBe('paged');
    expect(p.zone(7000)).toBe('paged');
    expect(p.zone(7500)).toBe('paged');
    expect(p.zone(7501)).toBe('free');
    expect(p.zone(12000)).toBe('free');
  });

  it('no table: nothing is consumed', () => {
    const p = createFlowPager();
    expect(p.wheel(100, 0, false, 0, 0)).toBe(false);
    p.setTable(tableFor());
    p.setTable(null);
    expect(p.wheel(100, 0, false, 0, 0)).toBe(false);
    p.touchStart(0, 0, 0, 0);
    expect(p.touchMove(0, 50, 0, 16).consumed).toBe(false);
    expect(p.frame(0, 0).scrollTo).toBeNull();
  });
});

describe('flow pager: wheel', () => {
  it('one notch = one stop, 1.5 s ease-out cubic, landing exactly on the rest', () => {
    const p = make();
    expect(p.wheel(100, 0, false, 0, 0)).toBe(true);
    expect(p.frame(0, 750).scrollTo).toBeCloseTo(875, 6); // 1 - 0.5^3
    const end = p.frame(875, 1500);
    expect(end.scrollTo).toBe(1000);
    expect(end.animating).toBe(false);
    expect(p.busy()).toBe(false);
  });

  it('deltas under 4 are consumed and ignored', () => {
    const p = make();
    expect(p.wheel(3, 0, false, 0, 0)).toBe(true);
    expect(p.busy()).toBe(false);
  });

  it('events during a move are swallowed, reverse included; the momentum tail waits for a 120 ms gap', () => {
    const p = make();
    p.wheel(100, 0, false, 1000, 0);
    expect(p.wheel(-100, 0, false, 1200, 300)).toBe(true);
    expect(p.wheel(100, 0, false, 1300, 400)).toBe(true);
    expect(run(p, 1000, 0, 1600)).toBe(2000);
    // a tail 50 ms after the last event: swallowed, no move
    expect(p.wheel(90, 0, false, 2000, 450)).toBe(true);
    expect(p.busy()).toBe(false);
    // after a 120 ms gap: a new page
    expect(p.wheel(90, 0, false, 2000, 1700)).toBe(true);
    expect(p.busy()).toBe(true);
    expect(run(p, 2000, 1700, 3300)).toBe(3000);
  });

  it('a sideways or Shift wheel is not consumed', () => {
    const p = make();
    expect(p.wheel(10, 40, false, 0, 0)).toBe(false);
    expect(p.wheel(100, 0, true, 0, 0)).toBe(false);
    expect(p.busy()).toBe(false);
  });

  it('up at the row does nothing (no wrap upwards)', () => {
    const p = make();
    expect(p.wheel(-100, 0, false, 0, 0)).toBe(true);
    expect(p.busy()).toBe(false);
  });

  it('a pack that cannot be focused swallows the down gesture at the row', () => {
    const p = make();
    p.setEntry(false);
    expect(p.wheel(100, 0, false, 0, 0)).toBe(true);
    expect(p.busy()).toBe(false);
    swipe(p, 0, 500, 0, -80);
    expect(p.busy()).toBe(false);
    expect(p.step(1, 0, 1000)).toBe(false);
    p.setEntry(true);
    expect(p.wheel(100, 0, false, 0, 2000)).toBe(true);
    expect(p.busy()).toBe(true);
  });

  it('durations: 1.0 s only between Pull Odds and Buyback, both ways; 1.5 s elsewhere, the lineup move included', () => {
    const at = (from: number, dy: number) => {
      const p = make();
      p.wheel(dy, 0, false, from, 0);
      let y = from;
      let t = 0;
      for (; t <= 3000; t += 10) {
        const f = p.frame(y, t);
        if (f.scrollTo !== null) y = f.scrollTo;
        if (!f.animating) break;
      }
      return t;
    };
    expect(at(3000, 100)).toBe(SAME_FRAMING_MS); // odds -> buyback
    expect(at(4000, -100)).toBe(SAME_FRAMING_MS); // buyback -> odds
    expect(at(2000, 100)).toBe(PAGE_MS); // tophits -> odds
    expect(at(4000, 100)).toBe(PAGE_MS); // buyback -> pulls
    expect(at(6000, 100)).toBe(PAGE_MS); // closing -> lineup
    expect(at(7000, -100)).toBe(PAGE_MS); // lineup -> closing
    expect(at(7000, 100)).toBe(PAGE_MS); // lineup -> exit end
  });

  it('a capsule pages five stops between the row and the lineup', () => {
    const p = make({}, focusStops('capsule'));
    let y = 0;
    const seen: number[] = [];
    for (let i = 0, now = 0; i < 6; i++, now += 2000) {
      p.wheel(100, 0, false, y, now);
      y = run(p, y, now, now + 1600);
      seen.push(y);
    }
    expect(seen).toEqual([1000, 2250, 3500, 4750, 6000, 7000]);
  });

  it('from the lineup, down glides through the exit to the free part', () => {
    const p = make();
    p.wheel(100, 0, false, 7000, 0);
    expect(run(p, 7000, 0, 1600)).toBe(8000);
    expect(p.zone(8000)).toBe('free');
  });

  it('an up notch at RL + 0.4 S goes to RL, not to Closing', () => {
    const p = make();
    expect(p.wheel(-100, 0, false, 7400, 0)).toBe(true);
    expect(run(p, 7400, 0, 1600)).toBe(7000);
  });

  it('off a rest, a notch goes to the next rest that way', () => {
    const p = make();
    p.wheel(100, 0, false, 2300, 0);
    expect(run(p, 2300, 0, 1600)).toBe(3000);
    const q = make();
    q.wheel(-100, 0, false, 2300, 0);
    expect(run(q, 2300, 0, 1600)).toBe(2000);
  });

  it('in the free part the wheel is native, except an up notch that would cross the edge: it pages to RL', () => {
    const p = make();
    expect(p.wheel(100, 0, false, 9000, 0)).toBe(false);
    expect(p.wheel(-100, 0, false, 9000, 1000)).toBe(false);
    expect(p.wheel(-120, 0, false, 7600, 2000)).toBe(true);
    expect(run(p, 7600, 2000, 3600)).toBe(7000);
  });

  it('keys step and go to a stop; nothing while a move runs', () => {
    const p = make();
    expect(p.step(1, 0, 0)).toBe(true);
    expect(p.step(1, 100, 10)).toBe(false);
    expect(run(p, 0, 0, 1600)).toBe(1000);
    expect(p.goTo(7, 1000, 2000)).toBe(true);
    expect(run(p, 1000, 2000, 3600)).toBe(7000);
    expect(p.step(-1, 7000, 4000)).toBe(true);
    expect(run(p, 7000, 4000, 5600)).toBe(6000);
    expect(p.goTo(0, 0, 6000)).toBe(false); // already at the row
  });
});

describe('flow pager: touch in the paged zone', () => {
  it('the page never follows the finger; over 24 px pages one stop, 24 or less stays', () => {
    const p = make();
    const [a, b] = swipe(p, 2000, 0, 0, -24);
    expect(a!.consumed && b!.consumed).toBe(true);
    expect(a!.scrollTo).toBeNull();
    expect(b!.scrollTo).toBeNull();
    expect(p.busy()).toBe(false);
    swipe(p, 2000, 100, 0, -30);
    expect(run(p, 2000, 148, 1700)).toBe(3000);
    swipe(p, 3000, 2000, 0, 30);
    expect(run(p, 3000, 2048, 3600)).toBe(2000);
  });

  it('touch moves take 1.5 s, also between Pull Odds and Buyback', () => {
    const p = make();
    swipe(p, 3000, 0, 0, -60);
    expect(p.frame(3000, 48 + 1000).animating).toBe(true);
    expect(run(p, 3000, 48, 48 + PAGE_MS + 16)).toBe(4000);
  });

  it('a touch during a move is ignored: the move lands on its target (fault 1)', () => {
    const p = make();
    p.wheel(100, 0, false, 1000, 0);
    let y = run(p, 1000, 0, 300);
    p.touchStart(200, 400, y, 300); // a tap
    p.touchEnd(y, 340);
    y = run(p, y, 304, 700);
    p.touchStart(200, 400, y, 700); // a swipe the other way
    expect(p.touchMove(200, 480, y, 716).consumed).toBe(true);
    p.touchEnd(y, 732);
    y = run(p, y, 716, 1600);
    expect(y).toBe(2000);
    expect(p.busy()).toBe(false);
    // nothing more happens afterwards
    expect(run(p, y, 1600, 3000)).toBe(2000);
  });

  it('a diagonal at 46 and 60 degrees from vertical gives no scroll change (fault 2)', () => {
    for (const deg of [46, 60, 90]) {
      const p = make();
      const { dx, dy } = fromDeg(deg);
      const [a, b] = swipe(p, 2000, 0, dx, dy);
      expect(a!.consumed && b!.consumed).toBe(true);
      expect(b!.axis).toBe('x');
      expect(a!.scrollTo).toBeNull();
      expect(p.busy()).toBe(false);
      for (let now = 48; now < 1000; now += 16)
        expect(p.frame(2000, now).scrollTo).toBeNull();
    }
  });

  it('30 and 44 degrees lock vertically and page', () => {
    for (const deg of [30, 44]) {
      const p = make();
      const { dx, dy } = fromDeg(deg);
      const [, b] = swipe(p, 2000, 0, dx, dy);
      expect(b!.axis).toBe('y');
      expect(run(p, 2000, 48, 1600)).toBe(3000);
    }
  });

  it('every diagonal on every stop ends on a rest', () => {
    const t = tableFor();
    const stops = t.stops;
    // a swipe up at the lineup goes on to the free part
    const ends = [...stops, t.exitEnd];
    for (const s of stops)
      for (const deg of [30, 44, 46, 60]) {
        const p = make();
        const { dx, dy } = fromDeg(deg);
        swipe(p, s, 0, dx, dy);
        const y = run(p, s, 48, 2500);
        expect(ends).toContain(y);
      }
  });

  it('a sideways touch on the Top Hits strip, or at the lineup, is not consumed', () => {
    const p = make();
    const [, b] = swipe(p, 2000, 0, 80, 0, { strip: true });
    expect(b!.consumed).toBe(false);
    const q = make();
    const [, c] = swipe(q, 7000, 0, 80, 0);
    expect(c!.consumed).toBe(false);
    expect(c!.axis).toBe('x');
    expect(q.busy()).toBe(false);
  });

  it('before the axis locks (under 6 px) the move is consumed', () => {
    const p = make();
    p.touchStart(200, 400, 2000, 0);
    expect(p.touchMove(203, 403, 2000, 16)).toMatchObject({
      consumed: true,
      axis: null,
    });
  });
});

describe('flow pager: the snap invariant', () => {
  it('a page left off a rest glides to the nearest rest after 150 ms of quiet, in 600 ms', () => {
    const p = make();
    expect(p.frame(2300, 0).idle).toBe(false);
    expect(p.frame(2300, 100).scrollTo).toBeNull();
    expect(p.busy()).toBe(false);
    p.frame(2300, 160);
    expect(p.busy()).toBe(true);
    expect(run(p, 2300, 160, 160 + SNAP_MS + 16)).toBe(2000);
    expect(p.frame(2000, 900).idle).toBe(true);
  });

  it('the quiet restarts while the scroll keeps changing', () => {
    const p = make();
    p.frame(2300, 0);
    p.frame(2350, 100);
    p.frame(2400, 200);
    expect(p.busy()).toBe(false);
    p.frame(2400, 360);
    expect(p.busy()).toBe(true);
    expect(run(p, 2400, 360, 1000)).toBe(2000);
  });

  it('between RL and the edge the nearest rest is RL; a held finger never snaps', () => {
    const p = make();
    p.frame(7450, 0);
    p.frame(7450, 200);
    expect(run(p, 7450, 200, 900)).toBe(7000);
    const q = make();
    q.touchStart(200, 400, 2300, 0);
    q.frame(2300, 0);
    q.frame(2300, 400);
    expect(q.busy()).toBe(false);
  });

  it('no snap in the free part', () => {
    const p = make();
    p.frame(9000, 0);
    p.frame(9000, 400);
    expect(p.busy()).toBe(false);
    expect(p.frame(9000, 500).idle).toBe(true);
  });
});

describe('flow pager: free touch and glide', () => {
  it('the glide is sign * |v|^1.7 (P §C: 16, 32, 48 px per frame give about 110, 360, 720 px)', () => {
    expect(glideDistance(16)).toBeGreaterThan(105);
    expect(glideDistance(16)).toBeLessThan(115);
    expect(glideDistance(32)).toBeGreaterThan(350);
    expect(glideDistance(32)).toBeLessThan(370);
    expect(glideDistance(48)).toBeGreaterThan(705);
    expect(glideDistance(48)).toBeLessThan(730);
    expect(glideDistance(-16)).toBeCloseTo(-glideDistance(16), 9);
    expect(glideDistance(0)).toBe(0);
  });

  it('the page follows the finger 1:1, vertical moves consumed, sideways ones left alone', () => {
    const p = make();
    p.touchStart(200, 600, 9000, 0);
    expect(p.touchMove(200, 500, 9000, 16)).toMatchObject({
      consumed: true,
      axis: 'y',
      scrollTo: 9100,
    });
    expect(p.touchMove(200, 450, 9100, 32).scrollTo).toBe(9150);
    const q = make();
    q.touchStart(200, 600, 9000, 0);
    expect(q.touchMove(300, 590, 9000, 16)).toMatchObject({
      consumed: false,
      axis: 'x',
      scrollTo: null,
    });
  });

  it('a flick glides on with lerp 0.075 per 60 Hz frame; a finger that stops first gets no glide', () => {
    const p = make();
    let y = 9000;
    p.touchStart(200, 600, y, 0);
    for (let i = 1; i <= 5; i++) {
      const m = p.touchMove(200, 600 - 32 * i, y, i * 16);
      y = m.scrollTo ?? y;
      p.frame(y, i * 16);
    }
    expect(y).toBe(9160);
    p.touchEnd(y, 90);
    // first frame of the glide: 7.5% of the way
    const g = p.frame(y, 96);
    expect(g.scrollTo! - 9160).toBeGreaterThan(0.06 * 362);
    expect(g.scrollTo! - 9160).toBeLessThan(0.09 * 362);
    const end = run(p, g.scrollTo!, 112, 4000);
    expect(end).toBeGreaterThan(9160 + 350);
    expect(end).toBeLessThan(9160 + 370);

    const q = make();
    y = 9000;
    q.touchStart(200, 600, y, 0);
    y = q.touchMove(200, 500, y, 16).scrollTo!;
    q.frame(y, 16);
    q.frame(y, 32); // the finger held still for a frame
    q.touchEnd(y, 40);
    expect(run(q, y, 48, 1000)).toBe(9100);
  });

  it('a touch during the glide stops it', () => {
    const p = make();
    let y = 9000;
    p.touchStart(200, 600, y, 0);
    y = p.touchMove(200, 552, y, 16).scrollTo!;
    p.frame(y, 16);
    p.touchEnd(y, 20);
    y = run(p, y, 32, 200);
    p.touchStart(200, 600, y, 210);
    expect(p.frame(y, 226).scrollTo).toBeNull();
    p.touchEnd(y, 240);
    expect(run(p, y, 256, 1000)).toBe(y);
  });

  it('an up glide from the free part stops at RL, never past it', () => {
    const p = make();
    let y = 8000;
    p.touchStart(200, 300, y, 0);
    for (let i = 1; i <= 6; i++) {
      const m = p.touchMove(200, 300 + 48 * i, y, i * 16);
      y = m.scrollTo ?? y;
      p.frame(y, i * 16);
    }
    expect(y).toBe(7712);
    p.touchEnd(y, 100);
    let min = y;
    for (let now = 112; now < 4000; now += 16) {
      const f = p.frame(y, now);
      if (f.scrollTo !== null) y = f.scrollTo;
      min = Math.min(min, y);
    }
    expect(y).toBe(7000);
    expect(min).toBe(7000);
  });

  it('the finger itself is held at the paged edge', () => {
    const p = make();
    p.touchStart(200, 300, 7600, 0);
    expect(p.touchMove(200, 600, 7600, 16).scrollTo).toBe(7500);
  });

  it('wheel and touch are swallowed during the exit move', () => {
    const p = make();
    p.wheel(100, 0, false, 7000, 0);
    const y = run(p, 7000, 0, 1000);
    expect(p.zone(y)).toBe('free');
    expect(p.wheel(-100, 0, false, y, 1010)).toBe(true);
    p.touchStart(200, 400, y, 1020);
    expect(p.touchMove(200, 300, y, 1036)).toMatchObject({
      consumed: true,
      scrollTo: null,
    });
    p.touchEnd(y, 1050);
    expect(run(p, y, 1016, 1600)).toBe(8000);
  });
});

describe('flow pager: a re-measure', () => {
  it('mid-move: the move lands on the same stop of the new table (fault 3)', () => {
    const p = make();
    p.wheel(100, 0, false, 1000, 0);
    let y = run(p, 1000, 0, 750);
    // the panel halves (S 500): stop 2 is now at 1000
    p.setTable(tableFor({ panel: 400 }));
    y = run(p, 1000 * (y / 2000), 752, 1600);
    expect(y).toBe(1000);
  });

  it('a variant change leaves RL and the free part where they were', () => {
    const p = make();
    p.setTable(tableFor({}, focusStops('noOdds')));
    expect(p.zone(7500)).toBe('paged');
    expect(p.zone(7501)).toBe('free');
    p.wheel(-100, 0, false, 7000, 0);
    expect(run(p, 7000, 0, 1600)).toBe(6000);
  });
});

describe('flow pager: agrees with the focus pager at the rests', () => {
  it('a notch and a swipe from a rest reach the same next stop', () => {
    const stops = [0, 1000, 2000, 3000];
    const a = createPager();
    a.setStops(stops);
    const b = createFlowPager();
    b.setTable({
      stops,
      kinds: ['front', 'tophits'],
      exitEnd: null,
      edge: 3500,
      lineup: false,
    });
    for (const [from, dy, t0] of [
      [1000, 100, 10000],
      [2000, -100, 20000],
    ] as const) {
      a.wheel(dy, 0, false, from, t0);
      b.wheel(dy, 0, false, from, t0);
      let ya: number = from;
      let yb: number = from;
      for (let t = t0; t <= t0 + 1600; t += 16) {
        const fa = a.frame(ya, t);
        const fb = b.frame(yb, t);
        if (fa.scrollTo !== null) ya = fa.scrollTo;
        if (fb.scrollTo !== null) yb = fb.scrollTo;
        expect(yb).toBeCloseTo(ya, 6);
      }
      expect(yb).toBe(from + Math.sign(dy) * 1000);
    }
  });

  it('forward past the last stop with no exit: nothing', () => {
    const b = createFlowPager();
    b.setTable({
      stops: [0, 1000],
      kinds: ['front'],
      exitEnd: null,
      edge: 1500,
      lineup: false,
    });
    expect(b.wheel(100, 0, false, 1000, 0)).toBe(true);
    expect(b.busy()).toBe(false);
  });
});
