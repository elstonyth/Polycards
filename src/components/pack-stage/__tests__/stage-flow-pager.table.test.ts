/**
 * The phone swipe from Just Pulled to the chosen pack, as a table: screen
 * sizes x gesture shapes x frame times, each run through the pure pager on
 * a simulated clock (frames every 8, 16 or 31 ms; touch events handled at
 * the frame after their own time, as a browser does). Every frame is checked
 * against what a visitor sees:
 *
 * 1. Rest: a move comes to rest only on a rest (never between the footer
 *    and the pack), and while the finger moves the page moves with it (no
 *    dead stop at an in-between place; the pack's rest, where the finger's
 *    follow ends, is the one place it may wait).
 * 2. Lift: the page speed in the first frames after the lift (50 ms) stays
 *    near the finger's speed over its last 100 ms: at most 1.5x it plus
 *    0.1 px/ms, never against it, and on the first frame at least half of it
 *    unless the page already reached its rest. After a still finger the page
 *    starts from rest: at most 0.1 px/ms on the first frame, then rising at
 *    most 0.1 px/ms a frame (a fixed cap over the window would judge the
 *    curve's length, not a jump: a trip of 880 px from rest passes it).
 * 3. Turned back: a swipe moving back up the page at the lift never goes on
 *    towards the pack and ends where it began.
 * 4. One way: during the finger and during the move after the lift the page
 *    goes one way only; from the move's first frame to its rest no frame
 *    stands still, and a lift starts the move on the next frame.
 * 5. One move: after the rest nothing moves again; nothing wraps on to the
 *    row (no lock, never at Last's top), a down gesture never goes up.
 * 6. Where Just Pulled is all in view at its rest, one swipe reaches the
 *    chosen pack; where it is not, the first swipe ends on the footer's rest
 *    (unless the finger itself carried the page past it: going back would
 *    break rule 4) and the same swipe again reaches the pack.
 *
 * Up the page (from the Just Pulled rest and the footer's rest) the same
 * rules hold with the lineup in the pack's place: one swipe reaches the
 * lineup; where Just Pulled is not all in view, a swipe from the footer
 * first ends on the Just Pulled rest (unless the finger carried the page
 * above it). A drag longer than the band to the paged edge checks that the
 * finger never holds the page still there.
 *
 * A cancelled touch settles from the next frame onto a rest (never left in the
 * half-empty band over the lineup), and a swipe turned back settles without
 * crawling: its last 5 px take at most 120 ms.
 *
 * Desktop (wheel and keys, from the footer's rest): rules 1, 4, 5, and one
 * gesture lands on the pack (a reversed notch mid-move is swallowed; a
 * Shift wheel moves nothing).
 *
 * Geometry and gestures come from the real traces in
 * docs/research/home-3d/full-flow/checkpoints/jp-to-pack/ (verify/ and
 * traces-r2/): the panel is the view under the header and above the tab bar
 * (viewport - 134 px), Just Pulled 657 px tall (637 at 430 wide), the footer
 * 213-275 px; 375x667 and 414x896 are interpolated from the traced widths.
 */
import { describe, expect, it } from 'vitest';

import { flowTable, type FlowGeometry, type FlowTable } from '../stage-flow';
import {
  createFlowPager,
  flowPagerTable,
  type FlowPager,
} from '../stage-flow-pager';
import { focusStops } from '../stage-focus-keys';

type Size = {
  name: string;
  w: number;
  h: number;
  /** Just Pulled's height. */
  jp: number;
  /** The footer (the last section) height. */
  footer: number;
  /** The table the browser traces measured, as a check on the geometry. */
  traced?: { exitEnd: number; ends: number[] };
};

const PHONES: Size[] = [
  {
    name: '390x844',
    w: 390,
    h: 844,
    jp: 657,
    footer: 257,
    traced: { exitEnd: 7101, ends: [7305, 8015, 8902.5] },
  },
  {
    name: '430x932',
    w: 430,
    h: 932,
    jp: 637,
    footer: 213,
    traced: { exitEnd: 7981, ends: [8033, 8831, 9828.5] },
  },
  {
    name: '360x640',
    w: 360,
    h: 640,
    jp: 657,
    footer: 275,
    traced: { exitEnd: 5061, ends: [5487, 5993, 6625.5] },
  },
  {
    name: '320x568',
    w: 320,
    h: 568,
    jp: 657,
    footer: 275,
    traced: { exitEnd: 4341, ends: [4798, 5273, 5815.5] },
  },
  { name: '375x667', w: 375, h: 667, jp: 657, footer: 266 },
  { name: '414x896', w: 414, h: 896, jp: 645, footer: 231 },
];
// shortcut: no desktop trace; the phone geometry at 1440x900, enough for the end's rest order
const DESKTOP: Size = {
  name: '1440x900',
  w: 1440,
  h: 900,
  jp: 657,
  footer: 300,
};

const FRAMES = [8, 16, 31] as const;
const HEADER_PX = 69;
/** Header plus tab bar: the panel (and the footer's view) is the viewport less this. */
const CHROME_PX = HEADER_PX + 65;

function geometry(s: Size): FlowGeometry {
  const panel = s.h - CHROME_PX;
  const S = panel * 1.25;
  const exitEnd = Math.round(Math.round(7 * S) + S);
  const riseTop = exitEnd + s.jp;
  const riseBottom = riseTop + s.footer;
  return {
    top: 0,
    panel,
    stops: 6,
    viewport: s.h,
    view: panel,
    riseSection: { top: riseTop, bottom: riseBottom },
    ret: { top: riseBottom, height: S },
    last: { top: riseBottom + S, height: s.h + 1 },
  };
}

function tableOf(s: Size): FlowTable {
  const t = flowTable(geometry(s));
  if (!t) throw new Error('no table');
  return t;
}

/**
 * The page with Just Pulled last (no footer): Just Pulled is itself the
 * section the chosen pack rises with, starting at the exit end (nothing
 * before it) and one panel tall under the header (its content centred in it).
 */
const noFooter = (s: Size): Size => ({
  ...s,
  jp: 0,
  footer: s.h - CHROME_PX + HEADER_PX,
});

/** Whether Just Pulled is all in view at its rest (its top at the view's top): the visitor's reading. */
const jpInView = (s: Size): boolean => s.jp <= s.h - CHROME_PX;

type TouchEv = {
  t: number;
  kind: 'start' | 'move' | 'end' | 'cancel';
  dy: number;
};
type DeskEv =
  | { t: number; kind: 'wheel'; dy: number; shift?: boolean }
  | { t: number; kind: 'key'; dir: 1 | -1; px?: number };

/** Moves every `every` ms from `from` (cumulative page-down px) by `step`, starting after `t0`. */
const moves = (
  n: number,
  every: number,
  step: number,
  t0 = 0,
  from = 0,
): TouchEv[] =>
  Array.from({ length: n }, (_, i) => ({
    t: t0 + (i + 1) * every,
    kind: 'move' as const,
    dy: from + (i + 1) * step,
  }));
const lastOf = (e: TouchEv[]): TouchEv => e[e.length - 1]!;

type Gesture = {
  name: string;
  from: 'jp' | 'footer';
  /** The page goes down the document: the swipe heads for the pack. */
  down: boolean;
  /** Up rows only: played from this rest alone. */
  onlyFrom?: 'jp' | 'footer';
  touch: (s: Size) => TouchEv[];
  desk: () => DeskEv[];
};

const START: TouchEv = { t: 0, kind: 'start', dy: 0 };
const GESTURES: Gesture[] = [
  {
    // 220 px in 3.4 s, a move every 63 ms (54 moves)
    name: 'slow drag',
    from: 'jp',
    down: true,
    touch: () => {
      const m = moves(54, 63, 220 / 54);
      return [START, ...m, { t: lastOf(m).t + 20, kind: 'end', dy: 220 }];
    },
    // a trackpad drag: 5 px every 16 ms for a second
    desk: () =>
      Array.from({ length: 62 }, (_, i) => ({
        t: i * 16,
        kind: 'wheel' as const,
        dy: 5,
      })),
  },
  {
    // 0.3 of the viewport in 0.6 s (253 px at 844), a move every 62 ms
    name: 'normal swipe',
    from: 'jp',
    down: true,
    touch: (s) => {
      const d = Math.round(0.3 * s.h);
      const m = moves(9, 62, d / 9);
      return [START, ...m, { t: lastOf(m).t + 20, kind: 'end', dy: d }];
    },
    desk: () => [{ t: 0, kind: 'wheel', dy: 100 }],
  },
  {
    // up to 450 px in 180 ms, three moves, lifted on the last
    name: 'hard flick',
    from: 'jp',
    down: true,
    touch: (s) => {
      const d = Math.min(450, Math.round(0.66 * s.h));
      return [
        START,
        { t: 44, kind: 'move', dy: d / 3 },
        { t: 103, kind: 'move', dy: (2 * d) / 3 },
        { t: 180, kind: 'move', dy: d },
        { t: 180, kind: 'end', dy: d },
      ];
    },
    // a trackpad's inertia tail: 120 px decaying for about 2.5 s
    desk: () => {
      const out: DeskEv[] = [];
      for (let i = 0, d = 120; d >= 1; i++, d *= 0.97)
        out.push({ t: i * 16, kind: 'wheel', dy: d });
      return out;
    },
  },
  {
    name: '26 px swipe',
    from: 'jp',
    down: true,
    touch: () => [
      START,
      { t: 65, kind: 'move', dy: 13 },
      { t: 130, kind: 'move', dy: 26 },
      { t: 130, kind: 'end', dy: 26 },
    ],
    desk: () => [{ t: 0, kind: 'wheel', dy: 26 }],
  },
  {
    // 200 px down, then 120 px back up the page, lifted while going up (net 80)
    name: 'turned back',
    from: 'jp',
    down: false,
    touch: () => {
      const a = moves(10, 62, 20);
      const b = moves(6, 62, -20, lastOf(a).t, 200);
      return [START, ...a, ...b, { t: lastOf(b).t + 60, kind: 'end', dy: 80 }];
    },
    // a notch down, then a notch up mid-move: swallowed
    desk: () => [
      { t: 0, kind: 'wheel', dy: 100 },
      { t: 300, kind: 'wheel', dy: -100 },
    ],
  },
  {
    // 120 px in 200 ms, then held still 500 ms before the lift
    name: 'hold then lift',
    from: 'jp',
    down: true,
    touch: () => [
      START,
      ...moves(13, 200 / 13, 120 / 13),
      { t: 700, kind: 'end', dy: 120 },
    ],
    // Arrow Down held 800 ms: auto-repeat every 33 ms from 500 ms
    desk: () => [
      { t: 0, kind: 'key', dir: 1 },
      ...Array.from({ length: 10 }, (_, i) => ({
        t: 500 + i * 33,
        kind: 'key' as const,
        dir: 1 as const,
      })),
    ],
  },
  {
    // 30 px in 100 ms, then held 500 ms: the longest move after a still finger
    name: 'short hold',
    from: 'jp',
    down: true,
    touch: () => [START, ...moves(5, 20, 6), { t: 600, kind: 'end', dy: 30 }],
    desk: () => [{ t: 0, kind: 'wheel', dy: 30 }],
  },
  {
    // from the footer's rest: 180 px, then the touch is cancelled
    name: 'touch cancel',
    from: 'footer',
    down: false,
    touch: () => {
      const m = moves(6, 62, 30);
      return [START, ...m, { t: 430, kind: 'cancel', dy: 180 }];
    },
    // a sideways (Shift) wheel: not the pager's
    desk: () => [{ t: 0, kind: 'wheel', dy: 100, shift: true }],
  },
];

/** The touch gestures turned up the page (finger down the screen), plus a drag past the band to the paged edge. */
const UP: Gesture[] = [
  ...GESTURES.filter((g) => g.name !== 'touch cancel').map((g) => ({
    ...g,
    name: `up ${g.name}`,
    down: false,
    touch: (s: Size) => g.touch(s).map((e) => ({ ...e, dy: -e.dy })),
  })),
  {
    // 600 px in 1 s, a move every 50 ms: from Just Pulled at 390x844 the paged edge is 444 px up
    name: 'up long drag',
    from: 'jp',
    down: false,
    touch: () => {
      const m = moves(20, 50, -30);
      return [START, ...m, { t: lastOf(m).t + 20, kind: 'end', dy: -600 }];
    },
    desk: () => [],
  },
  {
    // 180 px up the page from the Just Pulled rest, then the touch is cancelled: in the band over the lineup
    name: 'up touch cancel',
    from: 'jp',
    down: false,
    onlyFrom: 'jp',
    touch: () => {
      const m = moves(6, 62, -30);
      return [START, ...m, { t: 430, kind: 'cancel', dy: -180 }];
    },
    desk: () => [],
  },
];

/** Runs after the last event: the longest move (1.5 s) plus a snap and a margin. */
const SETTLE_MS = 3000;
const FINGER_Y = 600;

type Frame = {
  now: number;
  y: number;
  /** The finger's page-down travel delivered by this frame. */
  finger: number;
  /** The lift (or cancel) was delivered at or before this frame. */
  lifted: boolean;
  locked: boolean;
};
type Played = { frames: Frame[]; lift: number; vFinger: number; y0: number };

/** The finger's speed (px/ms, + down the page) over its moves in the 100 ms before its last one; 0 if it rested 100 ms. */
function fingerSpeed(ev: TouchEv[]): number {
  const end = lastOf(ev);
  const m = ev.filter((e) => e.kind !== 'end' && e.kind !== 'cancel');
  const last = lastOf(m);
  if (end.t - last.t > 100) return 0;
  let i = m.findIndex((e) => last.t - e.t <= 100);
  if (i >= m.length - 1) i = m.length - 2;
  const first = m[i]!;
  return last.t > first.t ? (last.dy - first.dy) / (last.t - first.t) : 0;
}

function playTouch(
  p: FlowPager,
  y0: number,
  t0: number,
  ev: TouchEv[],
  dt: number,
): Played {
  const frames: Frame[] = [];
  let y = y0;
  let finger = 0;
  let lifted = false;
  let lift = -1;
  let i = 0;
  const endT = t0 + lastOf(ev).t + SETTLE_MS;
  // start on a frame boundary of this clock
  for (let now = Math.ceil(t0 / dt) * dt; now <= endT; now += dt) {
    for (; i < ev.length && t0 + ev[i]!.t <= now; i++) {
      const e = ev[i]!;
      const at = t0 + e.t;
      const fy = FINGER_Y - e.dy;
      if (e.kind === 'start') p.touchStart(195, fy, y, now, at);
      else if (e.kind === 'move') {
        const r = p.touchMove(195, fy, y, now, at);
        if (r.scrollTo !== null) y = r.scrollTo;
      } else if (e.kind === 'end') p.touchEnd(y, now, at);
      else p.touchCancel();
      if (e.kind === 'end' || e.kind === 'cancel') lifted = true;
      else finger = e.dy;
    }
    const f = p.frame(y, now);
    if (f.scrollTo !== null) y = f.scrollTo;
    if (lifted && lift < 0) lift = frames.length;
    frames.push({
      now,
      y,
      finger,
      lifted,
      locked: (f.wrap ?? null) !== null || (f.lock ?? null) !== null,
    });
  }
  return { frames, lift, vFinger: fingerSpeed(ev), y0 };
}

/** Plays wheel and key events; what the pager leaves to the browser scrolls natively (a key: 40 px). */
function playDesk(p: FlowPager, y0: number, ev: DeskEv[], dt: number): Played {
  const frames: Frame[] = [];
  let y = y0;
  let i = 0;
  const endT = ev[ev.length - 1]!.t + SETTLE_MS;
  for (let now = 0; now <= endT; now += dt) {
    for (; i < ev.length && ev[i]!.t <= now; i++) {
      const e = ev[i]!;
      if (e.kind === 'wheel') {
        const dx = e.shift ? e.dy : 0;
        const dy = e.shift ? 0 : e.dy;
        if (!p.wheel(dy, dx, !!e.shift, y, now)) y += dy;
      } else if (p.step(e.dir, y, now) === 'free') y += (e.px ?? 40) * e.dir;
    }
    const f = p.frame(y, now);
    if (f.scrollTo !== null) y = f.scrollTo;
    frames.push({
      now,
      y,
      finger: 0,
      lifted: true,
      locked: (f.wrap ?? null) !== null || (f.lock ?? null) !== null,
    });
  }
  return { frames, lift: 0, vFinger: 0, y0 };
}

const SAME = 0.5;
const near = (a: number, b: number) => Math.abs(a - b) <= SAME;
const LIFT_WINDOW_MS = 50;
const SPEED_RATIO_MAX = 1.5;
const SPEED_SLACK = 0.1;
const SPEED_RATIO_MIN = 0.5;

type Expect = {
  /** The rest it must end on. */
  rest: number;
  /** Checks for a lift: the speed rule and a move from the next frame. */
  lift: boolean;
  /** The gesture's way down the page (+1), up (-1), or none known (0). */
  way: number;
  /** The swipe's way before a turn back: down the page (+1, the default) or up (-1). */
  swipe?: 1 | -1;
  /** A cancelled touch: the settle starts on the next frame. */
  settleNow?: boolean;
};

/** A turned-back swipe's last 5 px take at most this long. */
const TAIL_MS = 120;

/** The visitor's rules over one played gesture; returns the faults found (empty: none). */
function faults(t: FlowTable, run: Played, x: Expect, g: Gesture): string[] {
  const out: string[] = [];
  const f = run.frames;
  const pack = t.ends[1]!;
  /** Where the finger's follow ends, the one place the page may wait under it. */
  const holds = [pack, t.stops[t.stops.length - 1]!];
  const rests = [...t.stops, t.exitEnd, ...t.ends];
  const final = f[f.length - 1]!.y;
  const at = (k: number) =>
    `${Math.round(f[k]!.now)} ms, y ${f[k]!.y.toFixed(1)}`;

  // 1. rest: on a rest, and the finger takes the page with it
  if (!rests.some((r) => near(r, final)))
    out.push(`rest: came to rest off a rest at y ${final.toFixed(1)}`);
  else if (!near(final, x.rest))
    out.push(`rest: ended at ${final.toFixed(1)}, not ${x.rest}`);
  for (let k = 1; k < f.length && !f[k]!.lifted; k++) {
    const df = f[k]!.finger - f[k - 1]!.finger;
    const dy = f[k]!.y - f[k - 1]!.y;
    if (Math.abs(f[k]!.finger) < 6 || Math.abs(df) < 1) continue; // the axis lock's slop
    if (Math.abs(dy) < SAME && !holds.some((h) => near(f[k]!.y, h))) {
      out.push(`rest: dead stop while the finger moves at ${at(k)}`);
      break;
    }
    if (dy * df < 0) {
      out.push(`one way: the page went against the finger at ${at(k)}`);
      break;
    }
  }

  const L = run.lift;
  if (L < 0) return [...out, 'no lift delivered'];
  // the move after the lift: from its first moving frame to the final rest
  let settle = f.length - 1;
  while (settle > L && near(f[settle - 1]!.y, final)) settle--;
  let first = L + 1;
  while (first < settle && f[first]!.y === f[first - 1]!.y) first++;

  // 2. lift: the speed carries on from the finger's
  if (x.lift && settle > L) {
    const v = run.vFinger;
    let prev = 0;
    for (
      let k = L + 1;
      k < f.length && f[k]!.now - f[L]!.now <= LIFT_WINDOW_MS;
      k++
    ) {
      const pv = (f[k]!.y - f[k - 1]!.y) / (f[k]!.now - f[k - 1]!.now);
      const s = Math.sign(v) || Math.sign(pv) || 1;
      // a still finger: from rest, then speeding up on its curve, never by a jump
      const hi =
        v === 0
          ? prev + SPEED_SLACK
          : SPEED_RATIO_MAX * Math.abs(v) + SPEED_SLACK;
      prev = pv * s;
      const lo = SPEED_RATIO_MIN * Math.abs(v);
      const arrived = near(f[k]!.y, final);
      // the floor only on the first frame: a short ease-out then slows to its rest within the window
      const floor = k === L + 1 && pv * s < lo && !arrived;
      if (pv * s > hi || pv * s < -SPEED_SLACK || floor) {
        out.push(
          `lift: page ${pv.toFixed(3)} px/ms after the lift vs finger ${v.toFixed(3)} at ${at(k)}`,
        );
        break;
      }
    }
    if (first !== L + 1)
      out.push(
        `one way: the move waited ${first - L - 1} frames after the lift`,
      );
  }

  if (x.settleNow && settle > L && first > L + 1)
    out.push(`settle: waited ${first - L - 1} frames after the cancel`);

  // 3. turned back: never on, back where it began, with no crawl at the end
  if (g.name.endsWith('turned back') && x.lift) {
    const tail = f.findIndex(
      (fr, j) => j > L && j <= settle && Math.abs(fr.y - final) <= 5,
    );
    if (tail >= 0 && f[settle]!.now - f[tail]!.now > TAIL_MS)
      out.push(
        `turned back: crawled its last 5 px for ${Math.round(f[settle]!.now - f[tail]!.now)} ms`,
      );
    const yl = f[L]!.y;
    const sw = x.swipe ?? 1;
    const k = f.findIndex((fr, j) => j > L && (fr.y - yl) * sw > SAME);
    if (k >= 0)
      out.push(
        `turned back: went on the swipe's way after the lift at ${at(k)}`,
      );
  }

  // 4. one way, no stand-still mid-move
  for (let k = first + 1; k <= settle; k++) {
    const dy = f[k]!.y - f[k - 1]!.y;
    const dir = Math.sign(final - f[first - 1]!.y);
    if (dy * dir < 0) {
      out.push(`one way: turned back mid-move at ${at(k)}`);
      break;
    }
    if (Math.abs(dy) < 1e-3) {
      out.push(`one way: stood still mid-move at ${at(k)}`);
      break;
    }
  }

  // 5. one move, no wrap
  for (let k = settle; k < f.length; k++)
    if (!near(f[k]!.y, final)) {
      out.push(`one move: moved again after the rest at ${at(k)}`);
      break;
    }
  const wrap = f.findIndex(
    (fr) => fr.locked || (t.lastTop !== null && fr.y >= t.lastTop - SAME),
  );
  if (wrap >= 0) out.push(`wrap: on to the row at ${at(wrap)}`);
  if (x.way !== 0) {
    const back = f.findIndex((fr) => (fr.y - run.y0) * x.way < -SAME);
    if (back >= 0)
      out.push(`one way: the gesture went against its way at ${at(back)}`);
  }
  return out;
}

describe('the table reproduces the traced geometry', () => {
  it.each(PHONES.filter((s) => s.traced))('$name', (s) => {
    const t = tableOf(s);
    expect(t.exitEnd).toBe(s.traced!.exitEnd);
    expect(t.ends).toEqual(s.traced!.ends);
  });
});

const kinds = focusStops('sleeve');

describe('phone swipe from Just Pulled', () => {
  for (const s of PHONES)
    for (const g of GESTURES)
      for (const dt of FRAMES) {
        const name = `${s.name} ${g.name} @${dt}ms`;
        it(name, () => {
          const t = tableOf(s);
          const p = createFlowPager();
          p.setTable(flowPagerTable(t, kinds));
          const footer = t.ends[0]!;
          const pack = t.ends[1]!;
          const y0 = g.from === 'jp' ? t.exitEnd : footer;
          const ev = g.touch(s);
          const one = playTouch(p, y0, 0, ev, dt);
          // short screens stop at the footer, unless the finger already carried the page past it
          const yLift = one.frames[one.lift]?.y ?? y0;
          const twoStep = g.down && !jpInView(s) && yLift < footer - SAME;
          const rest = !g.down ? y0 : twoStep ? footer : pack;
          const found = faults(
            t,
            one,
            {
              rest,
              lift: g.name !== 'touch cancel',
              way: g.down ? 1 : 0,
              settleNow: g.name === 'touch cancel',
            },
            g,
          );
          if (twoStep) {
            // the same swipe again, from the footer's rest
            const at = one.frames[one.frames.length - 1]!;
            const two = playTouch(p, at.y, at.now + dt, ev, dt);
            for (const m of faults(
              t,
              two,
              { rest: pack, lift: true, way: 1 },
              g,
            ))
              found.push(`second swipe: ${m}`);
          }
          expect(found.join('\n')).toBe('');
        });
      }
});

describe('phone swipe up from Just Pulled and the footer rest', () => {
  for (const s of PHONES)
    for (const g of UP)
      for (const from of ['jp', 'footer'] as const)
        for (const dt of FRAMES) {
          if (g.onlyFrom && g.onlyFrom !== from) continue;
          it(`${s.name} ${g.name} from ${from} @${dt}ms`, () => {
            const t = tableOf(s);
            const p = createFlowPager();
            p.setTable(flowPagerTable(t, kinds));
            const lineup = t.stops[t.stops.length - 1]!;
            const y0 = from === 'jp' ? t.exitEnd : t.ends[0]!;
            const ev = g.touch(s);
            const one = playTouch(p, y0, 0, ev, dt);
            const back = g.name.endsWith('turned back');
            const cancel = g.name.endsWith('touch cancel');
            // short screens stop at Just Pulled's top, unless the finger already carried the page above it
            const yLift = one.frames[one.lift]?.y ?? y0;
            const twoStep =
              !back && !cancel && !jpInView(s) && yLift > t.exitEnd + SAME;
            // a cancel settles on the nearer rest: here Just Pulled's
            const rest = back || cancel ? y0 : twoStep ? t.exitEnd : lineup;
            const found = faults(
              t,
              one,
              {
                rest,
                lift: !cancel,
                way: back || cancel ? 0 : -1,
                swipe: -1,
                settleNow: cancel,
              },
              g,
            );
            if (twoStep) {
              const at = one.frames[one.frames.length - 1]!;
              const two = playTouch(p, at.y, at.now + dt, ev, dt);
              for (const m of faults(
                t,
                two,
                { rest: lineup, lift: true, way: -1, swipe: -1 },
                g,
              ))
                found.push(`second swipe: ${m}`);
            }
            expect(found.join('\n')).toBe('');
          });
        }
});

describe('desktop wheel and keys from the footer rest', () => {
  for (const g of GESTURES)
    for (const dt of FRAMES) {
      const name = `${DESKTOP.name} ${g.name} @${dt}ms`;
      it(name, () => {
        const t = tableOf(DESKTOP);
        const p = createFlowPager();
        p.setTable(flowPagerTable(t, kinds));
        const footer = t.ends[0]!;
        const run = playDesk(p, footer, g.desk(), dt);
        const sideways = g.name === 'touch cancel';
        const found = faults(
          t,
          run,
          {
            rest: sideways ? footer : t.ends[1]!,
            lift: false,
            way: sideways ? 0 : 1,
          },
          g,
        );
        if (sideways && run.frames.some((fr) => !near(fr.y, footer)))
          found.push('sideways: the page moved');
        expect(found.join('\n')).toBe('');
      });
    }
});

describe('desktop keys from the Just Pulled rest', () => {
  for (const [label, px] of [
    ['ArrowDown', 40],
    ['PageDown', Math.round(0.875 * DESKTOP.h)],
  ] as const)
    for (const dt of FRAMES)
      it(`${DESKTOP.name} ${label} @${dt}ms rests on the footer`, () => {
        const t = tableOf(DESKTOP);
        const p = createFlowPager();
        p.setTable(flowPagerTable(t, kinds));
        const run = playDesk(
          p,
          t.exitEnd,
          [{ t: 0, kind: 'key', dir: 1, px }],
          dt,
        );
        const g: Gesture = {
          name: label,
          from: 'jp',
          down: true,
          touch: () => [],
          desk: () => [],
        };
        const found = faults(
          t,
          run,
          { rest: t.ends[0]!, lift: false, way: 1 },
          g,
        );
        expect(found.join('\n')).toBe('');
      });
});

describe('the end with Just Pulled last (no footer)', () => {
  const sizes = PHONES.filter((s) =>
    ['390x844', '360x640', '320x568'].includes(s.name),
  );
  const gestures = [
    ...GESTURES,
    ...UP.filter((g) => !g.onlyFrom || g.onlyFrom === 'jp'),
  ];
  it.each(sizes)('$name: the footer rest is the Just Pulled rest', (s) => {
    const t = tableOf(noFooter(s));
    expect(t.ends[0]).toBe(t.exitEnd);
    expect(t.freeFits).toBe(true);
  });
  for (const s of sizes)
    for (const g of gestures)
      for (const dt of FRAMES)
        it(`${s.name} ${g.name} from Just Pulled @${dt}ms`, () => {
          const t = tableOf(noFooter(s));
          const p = createFlowPager();
          p.setTable(flowPagerTable(t, kinds));
          const y0 = t.exitEnd;
          const up = g.name.startsWith('up ');
          const back = g.name.endsWith('turned back');
          const cancel = g.name.endsWith('touch cancel');
          const run = playTouch(p, y0, 0, g.touch(s), dt);
          // down: on to the chosen pack; up: the lineup; a turn back or a cancel: back home
          const rest =
            back || cancel
              ? y0
              : up
                ? t.stops[t.stops.length - 1]!
                : t.ends[1]!;
          const found = faults(
            t,
            run,
            {
              rest,
              lift: !cancel,
              way: back || cancel ? 0 : up ? -1 : 1,
              swipe: up ? -1 : 1,
              settleNow: cancel,
            },
            g,
          );
          expect(found.join('\n')).toBe('');
        });
});
