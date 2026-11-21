import { describe, expect, it } from 'vitest';

import { WRAP_GUARD_MS, flowTable, type FlowGeometry } from '../stage-flow';
import {
  GLIDE_HANDOFF_PX,
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

// panel 800: S = 1000; rests 1000..6000, RL 7000, edge 7500, exit end 9000
// (a measured Exit spacer pins the exit end; the page's own layout, with no
// Exit height, is proven in stage-flow.test.ts)
const GEO: FlowGeometry = {
  top: 0,
  panel: 800,
  stops: 6,
  viewport: 800,
  exit: { top: 8000, height: 1000 },
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
/**
 * A free flick: the finger moves `speed` px/s (positive: finger up, page
 * down) for about `ms`, with frames every `dt` ms, then lets go; frames run
 * on at the same rate. Returns the scroll at release, at rest, and the time
 * from release to 90% of the glide.
 */
function flick(
  p: FlowPager,
  y0: number,
  speed: number,
  dt: number,
  ms = 100,
): { release: number; end: number; t90: number } {
  let y = y0;
  let now = 0;
  let finger = 600;
  p.touchStart(200, finger, y, now, now);
  p.frame(y, now);
  while (now + dt <= ms) {
    now += dt;
    finger -= (speed * dt) / 1000;
    y = p.touchMove(200, finger, y, now, now).scrollTo ?? y;
    p.frame(y, now);
  }
  const release = y;
  p.touchEnd(y, now, now);
  const seen: [number, number][] = [];
  for (let t = now + dt; t <= now + 8000; t += dt) {
    const f = p.frame(y, t);
    if (f.scrollTo !== null) y = f.scrollTo;
    seen.push([t - now, y]);
  }
  const goal = release + 0.9 * (y - release);
  const hit = seen.find(([, v]) => (y > release ? v >= goal : v <= goal));
  return { release, end: y, t90: hit ? hit[0] : Number.NaN };
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
  p.touchStart(200, 400, y, now, now, o);
  const a = p.touchMove(200 + dx / 2, 400 + dy / 2, y, now + 16, now + 16);
  const b = p.touchMove(200 + dx, 400 + dy, y, now + 32, now + 32);
  p.touchEnd(y, now + 48, now + 48);
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
    expect(t.exitEnd).toBe(9000);
    expect(t.lastTop).toBe(13000);
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
    p.touchStart(0, 0, 0, 0, 0);
    expect(p.touchMove(0, 50, 0, 16, 16).consumed).toBe(false);
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
    expect(p.step(1, 0, 1000)).toBe('swallowed');
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
    expect(run(p, 7000, 0, 1600)).toBe(9000);
    expect(p.zone(9000)).toBe('free');
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

  it('a very large up delta in the free part pages to the lineup, never stopping at the exit end', () => {
    const p = make();
    expect(p.wheel(-3000, 0, false, 9500, 0)).toBe(true);
    expect(run(p, 9500, 0, 1600)).toBe(7000);
  });

  it('keys step and go to a stop; swallowed while a move runs', () => {
    const p = make();
    expect(p.step(1, 0, 0)).toBe('moved');
    expect(p.step(1, 100, 10)).toBe('swallowed');
    expect(run(p, 0, 0, 1600)).toBe(1000);
    expect(p.goTo(7, 1000, 2000)).toBe('moved');
    expect(run(p, 1000, 2000, 3600)).toBe(7000);
    expect(p.step(-1, 7000, 4000)).toBe('moved');
    expect(run(p, 7000, 4000, 5600)).toBe(6000);
    expect(p.goTo(0, 0, 6000)).toBe('swallowed'); // already at the row
  });

  it('keys: swallowed where nothing moves in the paged zone, so the browser never scrolls there', () => {
    const p = make();
    expect(p.step(-1, 0, 0)).toBe('swallowed'); // up at the row
    p.setEntry(false);
    expect(p.step(1, 0, 0)).toBe('swallowed'); // entry refused
    expect(p.busy()).toBe(false);
  });

  it("keys in the free part are the browser's own", () => {
    const p = make();
    expect(p.step(-1, 20000, 0)).toBe('free');
    expect(p.step(1, 9500, 0)).toBe('free');
    expect(p.goTo(0, 20000, 0)).toBe('free');
    expect(p.busy()).toBe(false);
    expect(createFlowPager().step(1, 0, 0)).toBe('free'); // no table: no flow
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
    p.touchStart(200, 400, y, 300, 300); // a tap
    p.touchEnd(y, 340, 340);
    y = run(p, y, 304, 700);
    p.touchStart(200, 400, y, 700, 700); // a swipe the other way
    expect(p.touchMove(200, 480, y, 716, 716).consumed).toBe(true);
    p.touchEnd(y, 732, 732);
    y = run(p, y, 716, 1600);
    expect(y).toBe(2000);
    expect(p.busy()).toBe(false);
    // nothing more happens afterwards
    expect(run(p, y, 1600, 3000)).toBe(2000);
  });

  it("a swipe that starts late in a move and ends after the landing leaves the page on the move's stop", () => {
    const p = make();
    p.wheel(100, 0, false, 2000, 0); // 1.5 s to 3000
    let y = run(p, 2000, 0, 1392);
    p.touchStart(200, 400, y, 1400, 1400);
    p.touchMove(200, 340, y, 1416, 1416);
    y = run(p, y, 1408, 1592);
    expect(y).toBe(3000);
    p.touchMove(200, 300, y, 1596, 1596);
    p.touchEnd(y, 1600, 1600);
    expect(run(p, y, 1600, 3500)).toBe(3000);
    expect(p.busy()).toBe(false);
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
    p.touchStart(200, 400, 2000, 0, 0);
    expect(p.touchMove(203, 403, 2000, 16, 16)).toMatchObject({
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
    q.touchStart(200, 400, 2300, 0, 0);
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
  it('the glide is sign * |v|^1.7 (16, 32, 48 px per frame give about 110, 360, 720 px)', () => {
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
    p.touchStart(200, 600, 9000, 0, 0);
    expect(p.touchMove(200, 500, 9000, 16, 16)).toMatchObject({
      consumed: true,
      axis: 'y',
      scrollTo: 9100,
    });
    expect(p.touchMove(200, 450, 9100, 32, 32).scrollTo).toBe(9150);
    const q = make();
    q.touchStart(200, 600, 9000, 0, 0);
    expect(q.touchMove(300, 590, 9000, 16, 16)).toMatchObject({
      consumed: false,
      axis: 'x',
      scrollTo: null,
    });
  });

  it('a flick glides on with lerp 0.075 per 60 Hz frame; a finger that stops first gets no glide', () => {
    const p = make();
    let y = 9000;
    p.touchStart(200, 600, y, 0, 0);
    for (let i = 1; i <= 5; i++) {
      const m = p.touchMove(200, 600 - 32 * i, y, i * 16, i * 16);
      y = m.scrollTo ?? y;
      p.frame(y, i * 16);
    }
    expect(y).toBe(9160);
    p.touchEnd(y, 90, 90);
    // 32 px per 16 ms is 2000 px/s: 33.3 px per 60 Hz frame, gliding about 388 px
    const glide = 388;
    // first frame of the glide: 7.5% of the way
    const g = p.frame(y, 96);
    expect(g.scrollTo! - 9160).toBeGreaterThan(0.06 * glide);
    expect(g.scrollTo! - 9160).toBeLessThan(0.09 * glide);
    const end = run(p, g.scrollTo!, 112, 4000);
    expect(end).toBeGreaterThan(9160 + glide - 10);
    expect(end).toBeLessThan(9160 + glide + 10);

    const q = make();
    y = 9000;
    q.touchStart(200, 600, y, 0, 0);
    y = q.touchMove(200, 500, y, 16, 16).scrollTo!;
    q.frame(y, 16);
    // the finger held still for 150 ms (past the 100 ms hold), frames running
    for (let now = 32; now <= 160; now += 16) q.frame(y, now);
    q.touchEnd(y, 166, 166);
    expect(run(q, y, 176, 1000)).toBe(9100);
  });

  it('the glide is the same length at 120, 60 and 30 Hz frames (1920 px/s glides about 362 px)', () => {
    const at = (dt: number) => {
      const r = flick(make(), 9000, 1920, dt, 96);
      return r.end - r.release;
    };
    const base = at(1000 / 60);
    expect(base).toBeGreaterThan(352);
    expect(base).toBeLessThan(372);
    for (const dt of [8, 16, 33]) {
      expect(Math.abs(at(dt) - base)).toBeLessThan(0.03 * base);
    }
  });

  it('the glide eases over the same time at any frame rate', () => {
    const t8 = flick(make(), 9000, 1920, 8, 96).t90;
    const t33 = flick(make(), 9000, 1920, 33, 99).t90;
    // lerp 0.075 per 60 Hz frame: 90% after about 30 frames (0.5 s)
    expect(t8).toBeGreaterThan(450);
    expect(t8).toBeLessThan(550);
    expect(Math.abs(t33 - t8)).toBeLessThanOrEqual(33);
  });

  it('a re-measure that leaves the paged part alone keeps a free glide; a moved origin shifts it', () => {
    const plain = flick(make(), 9000, 1920, 16, 96);
    const glideOn = (g: Partial<FlowGeometry> | null) => {
      const p = make();
      let y = 9000;
      let finger = 600;
      p.touchStart(200, finger, y, 0, 0);
      for (let now = 16; now <= 96; now += 16) {
        finger -= 30.72;
        y = p.touchMove(200, finger, y, now, now).scrollTo ?? y;
        p.frame(y, now);
      }
      p.touchEnd(y, 96, 96);
      y = run(p, y, 112, 240);
      if (g) p.setTable(tableFor(g));
      return run(p, y + (g?.top ?? 0), 256, 6000);
    };
    // a free section grew (an image loaded): same paged part, same glide
    expect(glideOn({ telegram: { top: 11400, bottom: 12400 } })).toBeCloseTo(
      plain.end,
      6,
    );
    // something above the flow grew by 120 px: the glide moves with it
    expect(
      glideOn({ top: 120, exit: { top: 8120, height: 1000 } }),
    ).toBeCloseTo(plain.end + 120, 6);
    // the paged part changed (a new panel height): the glide stops
    const p = make();
    let y = 9000;
    p.touchStart(200, 600, y, 0, 0);
    y = p.touchMove(200, 552, y, 16, 16).scrollTo!;
    p.frame(y, 16);
    p.touchEnd(y, 20, 20);
    y = run(p, y, 32, 100);
    p.setTable(tableFor({ panel: 400 }));
    expect(p.frame(y, 116).scrollTo).toBeNull();
  });

  it('a touch during the glide stops it', () => {
    const p = make();
    let y = 9000;
    p.touchStart(200, 600, y, 0, 0);
    y = p.touchMove(200, 552, y, 16, 16).scrollTo!;
    p.frame(y, 16);
    p.touchEnd(y, 20, 20);
    y = run(p, y, 32, 200);
    p.touchStart(200, 600, y, 210, 210);
    expect(p.frame(y, 226).scrollTo).toBeNull();
    p.touchEnd(y, 240, 240);
    expect(run(p, y, 256, 1000)).toBe(y);
  });

  it('an up glide from the free part stops at RL, never past it', () => {
    const p = make();
    let y = 8000;
    p.touchStart(200, 300, y, 0, 0);
    for (let i = 1; i <= 6; i++) {
      const m = p.touchMove(200, 300 + 48 * i, y, i * 16, i * 16);
      y = m.scrollTo ?? y;
      p.frame(y, i * 16);
    }
    expect(y).toBe(7712);
    p.touchEnd(y, 100, 100);
    let min = y;
    for (let now = 112; now < 4000; now += 16) {
      const f = p.frame(y, now);
      if (f.scrollTo !== null) y = f.scrollTo;
      min = Math.min(min, y);
    }
    expect(y).toBe(7000);
    expect(min).toBe(7000);
  });

  it('an up glide that reaches the edge pages to the lineup at once', () => {
    const p = make();
    let y = 8000;
    p.touchStart(200, 300, y, 0, 0);
    for (let i = 1; i <= 6; i++) {
      y = p.touchMove(200, 300 + 48 * i, y, i * 16, i * 16).scrollTo ?? y;
      p.frame(y, i * 16);
    }
    p.touchEnd(y, 100, 100);
    let near: number | null = null;
    let landed: number | null = null;
    for (let now = 112; now < 4000; now += 16) {
      const f = p.frame(y, now);
      if (f.scrollTo !== null) y = f.scrollTo;
      if (near === null && y - 7500 <= GLIDE_HANDOFF_PX) {
        near = now;
        // the move to RL has begun by the frame that comes within a few px
        expect(p.busy()).toBe(true);
      }
      if (landed === null && y === 7000) landed = now;
    }
    expect(near).not.toBeNull();
    expect(landed! - near!).toBeLessThanOrEqual(SNAP_MS + 16);
  });

  it('released within a few px of the edge with an up flick: pages to the lineup on release', () => {
    const p = make();
    p.touchStart(200, 300, 7600, 0, 0);
    const y = p.touchMove(200, 397, 7600, 16, 16).scrollTo!;
    p.frame(y, 16);
    expect(y).toBe(7503);
    p.touchEnd(y, 20, 20);
    expect(p.busy()).toBe(true);
    expect(run(p, y, 32, 1000)).toBe(7000);
  });

  it('the finger itself is held at the paged edge', () => {
    const p = make();
    p.touchStart(200, 300, 7600, 0, 0);
    expect(p.touchMove(200, 600, 7600, 16, 16).scrollTo).toBe(7500);
  });

  it('wheel and touch are swallowed during the exit move', () => {
    const p = make();
    p.wheel(100, 0, false, 7000, 0);
    const y = run(p, 7000, 0, 1000);
    expect(p.zone(y)).toBe('free');
    expect(p.wheel(-100, 0, false, y, 1010)).toBe(true);
    p.touchStart(200, 400, y, 1020, 1020);
    expect(p.touchMove(200, 300, y, 1036, 1036)).toMatchObject({
      consumed: true,
      scrollTo: null,
    });
    p.touchEnd(y, 1050, 1050);
    expect(run(p, y, 1016, 1600)).toBe(9000);
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

  it('mid-move: the move carries on from where it was on the new table', () => {
    const p = make();
    p.wheel(100, 0, false, 1000, 0);
    const y = run(p, 1000, 0, 752); // 1000 -> 2000, half way in time
    p.setTable(tableFor({ panel: 400 })); // stop 1 at 500, stop 2 at 1000
    // the page keeps its place in the section: about y / 2, not the new target
    const f = p.frame(y / 2, 768);
    expect(f.scrollTo).toBeCloseTo(y / 2, -1);
    expect(f.scrollTo! < 990).toBe(true);
  });

  it('a pack change mid-move keeps the target by role: up from the lineup still lands on Closing', () => {
    const p = make(); // sleeve, six stops
    p.wheel(-100, 0, false, 7000, 0); // to Closing
    let y = run(p, 7000, 0, 288);
    p.setTable(tableFor({}, focusStops('capsule'))); // five stops
    let max = 0;
    for (let now = 304; now <= 1600; now += 16) {
      const f = p.frame(y, now);
      if (f.scrollTo !== null) y = f.scrollTo;
      max = Math.max(max, y);
    }
    expect(y).toBe(6000);
    expect(max).toBeLessThan(7000);
  });

  it('a pack change mid-move: Closing to the lineup lands on the lineup, not past it', () => {
    const p = make();
    p.wheel(100, 0, false, 6000, 0);
    const y = run(p, 6000, 0, 288);
    p.setTable(tableFor({}, focusStops('noOdds'))); // four stops
    expect(run(p, y, 304, 1600)).toBe(7000);
  });

  it('a pack change mid-move: the exit end stays the exit end; a pack stop keeps its distance from Closing', () => {
    const a = make();
    a.wheel(100, 0, false, 7000, 0);
    let y = run(a, 7000, 0, 288);
    a.setTable(tableFor({}, focusStops('capsule')));
    expect(run(a, y, 304, 1600)).toBe(9000);
    // sleeve: Buyback (4) up to Pull Odds (3), three before Closing; a
    // capsule's stop three before Closing is its second (2250)
    const b = make();
    b.wheel(-100, 0, false, 4000, 0);
    y = run(b, 4000, 0, 288);
    b.setTable(tableFor({}, focusStops('capsule')));
    expect(run(b, y, 304, 1600)).toBe(2250);
    // sleeve: up to Front (five before Closing); four stops have no such
    // stop: the nearest, Front
    const c = make();
    c.wheel(-100, 0, false, 2000, 0);
    y = run(c, 2000, 0, 288);
    c.setTable(tableFor({}, focusStops('noOdds')));
    expect(run(c, y, 304, 1600)).toBe(1000);
  });

  it('a pack change mid-move with no lineup stop (the stops end at Closing): roles still hold', () => {
    const t = (stops: number[]) => ({
      stops,
      kinds: focusStops('sleeve').slice(0, stops.length - 1),
      exitEnd: 9000,
      edge: 7500,
      lineup: false,
    });
    const six = [0, 1000, 2000, 3000, 4000, 5000, 6000];
    const five = [0, 1000, 2250, 3500, 4750, 6000];
    const p = createFlowPager();
    p.setTable(t(six));
    p.wheel(100, 0, false, 6000, 0); // Closing to the exit end
    let y = run(p, 6000, 0, 288);
    p.setTable(t(five));
    expect(run(p, y, 304, 1600)).toBe(9000);
    // Buyback up to Pull Odds, three before Closing: the capsule's second stop
    const q = createFlowPager();
    q.setTable(t(six));
    q.wheel(-100, 0, false, 4000, 0);
    y = run(q, 4000, 0, 288);
    q.setTable(t(five));
    expect(run(q, y, 304, 1600)).toBe(2250);
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

describe('flow pager: a flick whose last move and release land in the same frame', () => {
  it('still glides, on the last move not yet sampled by a frame', () => {
    const p = make();
    let y = 9500;
    p.touchStart(200, 600, y, 0, 0);
    p.frame(y, 0);
    // moves on every other frame (the frame between sees no movement)
    for (let i = 1; i <= 3; i++) {
      y = p.touchMove(200, 600 - 32 * i, y, i * 32, i * 32).scrollTo ?? y;
      p.frame(y, i * 32);
      p.frame(y, i * 32 + 16);
    }
    // the fourth move and the release, with no frame between them
    y = p.touchMove(200, 600 - 32 * 4, y, 128, 128).scrollTo ?? y;
    p.touchEnd(y, 130, 130);
    // 32 px per 32 ms is 16.7 px per 60 Hz frame: about 119 px of glide
    const end = run(p, y, 144, 3000);
    expect(end).toBeGreaterThan(y + 110);
    expect(end).toBeLessThan(y + 130);
  });
});

/**
 * A free flick with the finger at `speed` px/s (positive: finger up):
 * frames every `frameMs`, a move every `moveMs` landing just before a
 * frame, six moves; then `still` ms after the last move (frames run on,
 * none of them with a move) before the release. Frames run on for 6 s.
 */
function cadenceFlick(
  frameMs: number,
  moveMs: number,
  speed: number,
  still: number,
  y0 = 9000,
): { release: number; end: number; wraps: number } {
  const p = make();
  let y = y0;
  let finger = 700;
  let now = 0;
  let lastMove = 0;
  let next = moveMs;
  let moves = 0;
  p.touchStart(200, finger, y, 0, 0);
  p.frame(y, 0);
  while (moves < 6) {
    now += frameMs;
    if (now >= next - 1e-6) {
      finger -= (speed * moveMs) / 1000;
      lastMove = now - 0.5;
      y = p.touchMove(200, finger, y, lastMove, lastMove).scrollTo ?? y;
      next += moveMs;
      moves++;
    }
    p.frame(y, now);
  }
  while (now + frameMs < lastMove + still) {
    now += frameMs;
    p.frame(y, now);
  }
  const release = y;
  p.touchEnd(y, lastMove + still, lastMove + still);
  let wraps = 0;
  for (let t = now + frameMs; t <= now + 6000; t += frameMs) {
    const f = p.frame(y, t);
    if (f.wrap === 0) wraps++;
    if (f.scrollTo !== null) y = f.scrollTo;
  }
  return { release, end: y, wraps };
}

describe('flow pager: the release speed comes from the moves, not the frames', () => {
  // 1920 px/s is 32 px per 60 Hz frame: a glide of about 361 px
  const SPEED = 1920;
  it('a frame with no move before the release keeps the glide, at any frame and touch rate', () => {
    for (const [frameMs, moveMs] of [
      [1000 / 60, 1000 / 60], // 60 Hz screen, 60 Hz touch
      [1000 / 120, 1000 / 60], // 120 Hz screen, 60 Hz touch
      [31, 62], // a slow page: 31 ms frames, a move every 62 ms
    ] as const) {
      const r = cadenceFlick(frameMs, moveMs, SPEED, frameMs + 2);
      const glide = r.end - r.release;
      expect(glide, frameMs + ' ms frames').toBeGreaterThan(350);
      expect(glide, frameMs + ' ms frames').toBeLessThan(372);
    }
  });

  it('moves handled back to back (a busy page) are timed by their own event times: the true glide', () => {
    const p = make();
    let y = 9000;
    p.touchStart(200, 700, y, 0, 0);
    p.frame(y, 0);
    // a long task: five moves made 16 ms apart, all handled at 90 ms, within 0.5 ms
    for (let i = 1; i <= 5; i++)
      y = p.touchMove(200, 700 - 32 * i, y, 90 + i * 0.1, i * 16).scrollTo ?? y;
    p.touchEnd(y, 90.6, 82);
    const end = run(p, y, 96, 6000);
    // 32 px per 16 ms is 33.3 px per 60 Hz frame: about 388 px of glide
    expect(end - y).toBeGreaterThan(378);
    expect(end - y).toBeLessThan(398);
  });

  it('a finger held still for 150 ms before lifting does not glide', () => {
    const r = cadenceFlick(1000 / 60, 1000 / 60, SPEED, 150);
    expect(r.end).toBe(r.release);
  });

  it("a glide that crosses Last's top after a frame with no move wraps once and ends at the row", () => {
    // Last's top at 13000: 192 px of drag to 12800, then about 361 px of glide
    const r = cadenceFlick(1000 / 60, 1000 / 60, SPEED, 1000 / 60 + 2, 12608);
    expect(r.release).toBe(12800);
    expect(r.wraps).toBe(1);
    expect(r.end).toBe(0);
  });
});

/**
 * A free flick with its own touch clock: moves every `moveMs` (event time)
 * at `speed` px/s, frames every `frameMs`, each move handled at its own
 * time; the release `gap` ms after the last move. Returns the glide.
 */
function timedFlick(
  frameMs: number,
  moveMs: number,
  speed: number,
  gap = 2,
): number {
  const p = make();
  let y = 9000;
  let frameAt = 0;
  p.touchStart(200, 700, y, 0, 0);
  p.frame(y, 0);
  let t = 0;
  for (let i = 1; i <= 12; i++) {
    t = i * moveMs;
    while (frameAt + frameMs <= t) {
      frameAt += frameMs;
      p.frame(y, frameAt);
    }
    y = p.touchMove(200, 700 - (speed * t) / 1000, y, t, t).scrollTo ?? y;
  }
  p.touchEnd(y, t + gap, t + gap);
  const release = y;
  for (let f = frameAt + frameMs; f <= frameAt + 6000; f += frameMs) {
    const r = p.frame(y, f);
    if (r.scrollTo !== null) y = r.scrollTo;
  }
  return y - release;
}

describe('flow pager: the release speed is timed by the touch events themselves', () => {
  it('a touchend handled 150 ms late, made 10 ms after the last move, still glides', () => {
    const p = make();
    let y = 9000;
    p.touchStart(200, 700, y, 0, 0);
    p.frame(y, 0);
    for (let i = 1; i <= 5; i++) {
      y = p.touchMove(200, 700 - 32 * i, y, i * 16, i * 16).scrollTo ?? y;
      p.frame(y, i * 16);
    }
    p.touchEnd(y, 80 + 150, 90);
    const end = run(p, y, 240, 6000);
    expect(end - y).toBeGreaterThan(378);
    expect(end - y).toBeLessThan(398);
  });

  it('a 300 ms press, then a flick, glides: the moves before the axis lock keep the speed current', () => {
    const p = make();
    let y = 9000;
    p.touchStart(200, 700, y, 0, 0);
    p.frame(y, 0);
    // the finger creeps up 1 px at a time while pressing (under the 6 px lock)
    for (let i = 1; i <= 3; i++) {
      p.touchMove(200, 700 - i, y, i * 100, i * 100);
      p.frame(y, i * 100);
    }
    // then one 40 px flick and the lift
    y = p.touchMove(200, 657, y, 316, 316).scrollTo ?? y;
    expect(y).toBe(9043);
    p.touchEnd(y, 320, 320);
    // 40 px over 16 ms is 41.7 px per 60 Hz frame: about 570 px of glide
    const glide = run(p, y, 336, 6000) - y;
    expect(glide).toBeGreaterThan(540);
    expect(glide).toBeLessThan(600);
  });

  it('a last move that is sideways only, or rolls back 1 px at the lift, still glides forward', () => {
    for (const last of ['sideways', 'rollback'] as const) {
      const p = make();
      let y = 9000;
      p.touchStart(200, 700, y, 0, 0);
      p.frame(y, 0);
      for (let i = 1; i <= 5; i++) {
        y = p.touchMove(200, 700 - 32 * i, y, i * 16, i * 16).scrollTo ?? y;
        p.frame(y, i * 16);
      }
      const fy = last === 'sideways' ? 700 - 32 * 5 : 700 - 32 * 5 + 1;
      y = p.touchMove(210, fy, y, 96, 96).scrollTo ?? y;
      p.touchEnd(y, 98, 98);
      // over the whole 96 ms from the start: 160 px (159 rolled back) is
      // 27.8 (27.6) px per 60 Hz frame, about 285 (281) px of glide
      const glide = run(p, y, 112, 6000) - y;
      expect(glide, last).toBeGreaterThan(278);
      expect(glide, last).toBeLessThan(290);
    }
  });

  it('moves 80 ms apart (a slow touch rate) still glide, timed over the last two', () => {
    const p = make();
    let y = 9000;
    p.touchStart(200, 700, y, 0, 0);
    p.frame(y, 0);
    for (let i = 1; i <= 3; i++) {
      y = p.touchMove(200, 700 - 150 * i, y, i * 80, i * 80).scrollTo ?? y;
      p.frame(y, i * 80);
    }
    p.touchEnd(y, 270, 270);
    // 150 px per 80 ms is 31.25 px per 60 Hz frame: about 347 px of glide
    const glide = run(p, y, 272, 6000) - y;
    expect(glide).toBeGreaterThan(337);
    expect(glide).toBeLessThan(357);
  });

  it('a finger resting 150 ms before the lift gets no glide, whenever the lift is handled', () => {
    const p = make();
    let y = 9000;
    p.touchStart(200, 700, y, 0, 0);
    p.frame(y, 0);
    for (let i = 1; i <= 5; i++) {
      y = p.touchMove(200, 700 - 32 * i, y, i * 16, i * 16).scrollTo ?? y;
      p.frame(y, i * 16);
    }
    for (let now = 96; now <= 224; now += 16) p.frame(y, now);
    // made 150 ms after the last move, handled at once
    p.touchEnd(y, 230, 230);
    expect(run(p, y, 240, 2000)).toBe(y);
  });

  it('the same finger speed gives the same glide at 60 and 120 Hz frames with 60 and 120 Hz touch', () => {
    const glides = [
      timedFlick(1000 / 60, 1000 / 60, 1920),
      timedFlick(1000 / 120, 1000 / 60, 1920),
      timedFlick(1000 / 60, 1000 / 120, 1920),
      timedFlick(1000 / 120, 1000 / 120, 1920),
    ];
    // 1920 px/s is 32 px per 60 Hz frame: about 361 px
    for (const g of glides) {
      expect(g).toBeGreaterThan(350);
      expect(g).toBeLessThan(372);
    }
  });
});

describe('flow pager: an up drag held at the paged edge', () => {
  it('pages to the lineup even when the browser rounds the scroll just past the edge', () => {
    const p = make();
    let y = 7540;
    p.touchStart(200, 300, y, 0, 0);
    p.frame(y, 0);
    for (let i = 1; i <= 6; i++) {
      y = p.touchMove(200, 300 + 40 * i, y, i * 16, i * 16).scrollTo ?? y;
      p.frame(y, i * 16);
    }
    expect(y).toBe(7500); // the follow stops at the edge
    // the device-pixel grid leaves the page a fraction above it
    p.touchEnd(7500.4, 120, 120);
    expect(run(p, 7500.4, 136, 1200)).toBe(7000);
  });
});

describe('flow pager: a touch on a sideways scroller in the free part', () => {
  it('is the browser own in every direction: never consumed, no follow, no glide', () => {
    const p = make();
    p.touchStart(200, 600, 9500, 0, 0, { strip: true });
    expect(p.touchMove(202, 598, 9500, 16, 16).consumed).toBe(false);
    const m = p.touchMove(200, 400, 9500, 32, 32);
    expect(m.consumed).toBe(false);
    expect(m.scrollTo).toBeNull();
    p.touchEnd(9500, 48, 48);
    expect(run(p, 9500, 64, 1000)).toBe(9500);
  });
});

describe('flow pager: the wrap', () => {
  it("a flick across Last's top wraps once to the overshoot, then the 1.2 s lock eases to the row", () => {
    const p = make();
    let y = 12800;
    p.touchStart(200, 600, y, 0, 0);
    for (let i = 1; i <= 3; i++) {
      y = p.touchMove(200, 600 - 48 * i, y, i * 16, i * 16).scrollTo ?? y;
      p.frame(y, i * 16);
    }
    expect(y).toBe(12944);
    p.touchEnd(y, 50, 50);
    let wraps = 0;
    let wrappedAt: number | null = null;
    let after: number[] = [];
    for (let now = 64; now < 4000; now += 16) {
      const f = p.frame(y, now);
      if (f.wrap === 0) {
        wraps++;
        wrappedAt = now;
        expect(f.scrollTo!).toBeGreaterThan(0);
        expect(f.scrollTo!).toBeLessThan(800);
      }
      if (f.scrollTo !== null) y = f.scrollTo;
      if (wrappedAt !== null) after.push(y);
    }
    expect(wraps).toBe(1);
    // never dragged back towards Last: it only falls to the row
    for (let i = 1; i < after.length; i++)
      expect(after[i]!).toBeLessThanOrEqual(after[i - 1]!);
    expect(y).toBe(0);
    after = [];
  });

  it("a native scroll across Last's top (scrollbar, End) wraps too, and the lock lands on the row in 1.2 s", () => {
    const p = make();
    p.frame(12990, 0);
    const f = p.frame(13050, 16);
    expect(f.scrollTo).toBe(50);
    expect(f.wrap).toBe(0);
    expect(p.busy()).toBe(true);
    const mid = p.frame(50, 16 + 600);
    expect(mid.scrollTo).toBeCloseTo(50 * 0.125, 6); // ease-out cubic at half time
    expect(mid.wrap).toBe(600);
    const end = p.frame(mid.scrollTo!, 16 + WRAP_GUARD_MS);
    expect(end.scrollTo).toBe(0);
    expect(p.busy()).toBe(false);
    expect(p.frame(0, 2000).wrap ?? null).toBeNull();
  });

  it('a finger held through the wrap writes nothing, during the lock or after it', () => {
    const p = make();
    let y = 12900;
    p.touchStart(200, 600, y, 0, 0);
    y = p.touchMove(200, 550, y, 16, 16).scrollTo!;
    p.frame(y, 16);
    y = p.touchMove(200, 480, y, 32, 32).scrollTo!;
    expect(y).toBe(13020);
    const w = p.frame(y, 32);
    expect(w.scrollTo).toBe(20);
    y = 20;
    expect(p.touchMove(200, 400, y, 48, 48).scrollTo).toBeNull();
    for (let now = 48; now <= 32 + WRAP_GUARD_MS + 16; now += 16) {
      const f = p.frame(y, now);
      if (f.scrollTo !== null) y = f.scrollTo;
    }
    expect(y).toBe(0);
    expect(p.touchMove(200, 300, y, 1400, 1400).scrollTo).toBeNull();
    p.touchEnd(y, 1420, 1420);
    expect(run(p, y, 1432, 3000)).toBe(0);
  });

  it('wheel, keys and touch paging are swallowed during the lock', () => {
    const p = make();
    p.frame(12990, 0);
    let y = p.frame(13030, 16).scrollTo!;
    expect(p.wheel(100, 0, false, y, 100)).toBe(true);
    expect(p.step(1, y, 120)).toBe('swallowed');
    expect(p.goTo(3, y, 130)).toBe('swallowed');
    p.touchStart(200, 400, y, 140, 140);
    p.touchMove(200, 300, y, 156, 156);
    p.touchEnd(y, 170, 170);
    y = run(p, y, 32, 16 + WRAP_GUARD_MS + 16);
    expect(y).toBe(0);
    expect(run(p, y, 1300, 3000)).toBe(0);
    // paging resumes after the lock
    expect(p.wheel(100, 0, false, 0, 3200)).toBe(true);
    expect(run(p, 0, 3200, 4800)).toBe(1000);
  });

  it("never upwards, and a re-measure that moves Last's top is not a crossing", () => {
    const p = make();
    p.frame(13300, 0);
    expect(p.frame(12900, 16).scrollTo).toBeNull(); // up across it: nothing
    const q = make();
    q.frame(12990, 0);
    q.setTable(tableFor({ last: { top: 12950, height: 801 } }));
    expect(q.frame(12990, 16).scrollTo).toBeNull();
    expect(q.busy()).toBe(false);
  });

  it('a page left inside Last by a re-measure wraps on its next downward movement', () => {
    const q = make();
    q.frame(12990, 0);
    q.setTable(
      tableFor({
        ret: { top: 12000, height: 950 },
        last: { top: 12950, height: 801 },
      }),
    );
    expect(q.frame(12990, 16).scrollTo).toBeNull();
    const f = q.frame(13000, 32);
    expect(f.wrap).toBe(0);
    expect(f.scrollTo).toBe(10);
  });

  it('the wrap lands on R0 plus the overshoot when the row does not start at 0', () => {
    const p = make({
      top: 200,
      telegram: { top: 11200, bottom: 12200 },
      ret: { top: 12200, height: 1000 },
      last: { top: 13200, height: 801 },
    });
    p.frame(13190, 0);
    const f = p.frame(13230, 16);
    expect(f.wrap).toBe(0);
    expect(f.scrollTo).toBe(230);
    expect(run(p, 230, 32, 32 + WRAP_GUARD_MS + 16)).toBe(200);
  });

  it('home(): from the lineup, the same lock eases to the row (Home and Escape at the lineup)', () => {
    const p = make();
    const f0 = p.home(7000, 0);
    expect(f0).toBe('moved');
    const f = p.frame(7000, 16);
    expect(f.wrap).toBe(0);
    expect(f.lock).toBe('home');
    expect(p.busy()).toBe(true);
    const mid = p.frame(7000, 16 + 600);
    expect(mid.scrollTo).toBeCloseTo(7000 * 0.125, 6);
    expect(mid.lock).toBe('home');
    expect(run(p, mid.scrollTo!, 632, 16 + WRAP_GUARD_MS + 16)).toBe(0);
    expect(p.busy()).toBe(false);
    // only from a rest in the paged part, never mid-move or in the free part
    const q = make();
    expect(q.home(9500, 0)).toBe('free');
    q.step(1, 0, 0);
    expect(q.home(100, 50)).toBe('swallowed');
  });

  it('the wrap frame says it is the wrap', () => {
    const p = make();
    p.frame(12990, 0);
    expect(p.frame(13030, 16).lock).toBe('wrap');
  });

  it('no Last in the table: no wrap', () => {
    const p = make({ last: null });
    p.frame(12990, 0);
    expect(p.frame(13050, 16).scrollTo).toBeNull();
  });
});

describe('flow pager: the page with no Exit height (Just Pulled follows the lineup)', () => {
  it('from the lineup, down glides one section to the free part', () => {
    const p = make({ exit: null });
    p.wheel(100, 0, false, 7000, 0);
    expect(run(p, 7000, 0, 1600)).toBe(8000);
    expect(p.zone(8000)).toBe('free');
  });
});
