/**
 * Pack stage: the full-page flow model. Pure: no DOM, no clock, no React, no three.js. Imported only by the
 * lazy stage chunks, never by the first load.
 *
 * The page is one table of scroll positions. The paged part: the row rest
 * R0, the focused pack's stops spread over a band of six sections, and the
 * lineup rest RL. The free part: the lineup exit, from the lineup rest over
 * the Lineup spacer (ending where the first section's top meets the viewport top),
 * so the row starts leaving on the first pixel of scroll below RL and the
 * first section rises in as it leaves; then the free content, the rise
 * (keyed to the last section, whichever the page lists last), Return and
 * Last. One value, the flow
 * position P, is read from the scroll; every pose and text switch is a
 * function of P only, so scrolling back retraces the way down exactly.
 *
 * The table is rebuilt from live geometry on every re-measure (never cached
 * from a page height); a caller keeps P across a re-measure with
 * `flowAt` on the old table and `flowPosition` on the new one.
 */
import type { StageLap } from './contract';
import { power1InOut } from './stage-focus';
import { clamp01, easeOutCubic } from './stage-spin-math';

/** One section: 1.25 panels, the same length as the row's own exit; the lineup exit runs over one section. */
export const FLOW_SECTION_PANELS = 1.25;
/** The detail band: six slots, Front to Closing, for every variant. */
export const FLOW_DETAIL_SLOTS = 6;
/** The lineup rest sits one section after the band: R0 + 7 S. */
export const FLOW_LINEUP_SLOT = FLOW_DETAIL_SLOTS + 1;
/** The rise starts when the last section's top reaches this share of the viewport (296 of 844 px on a phone). */
export const RISE_START_VIEWPORT = 0.35;
/** The others' row spacing at the start of the hand-off and of Return, in row steps. */
export const FLOW_SPREAD_FROM = 5;
/** ... and at the end: the row's own step. */
export const FLOW_SPREAD_TO = 1;
/** The locked scroll back to the row after the wrap (measured 1.1-1.3 s). */
export const WRAP_GUARD_MS = 1200;
/** The row UI fades back in over this after the wrap (measured 0.06-0.40 s). */
export const WRAP_UI_FADE_MS = 350;

/** Live geometry, in document scroll pixels (a rect's top plus the scroll it was read at). */
export type FlowGeometry = {
  /** The row rest R0: the flow root's top. */
  top: number;
  /** The stage panel's height (px). */
  panel: number;
  /** The focused pack's stop count (sleeve 6, capsule 5, noOdds 4). */
  stops: number;
  /** The viewport height (px) the rise start is a share of. */
  viewport: number;
  /**
   * The height seen under the site header and above the tab bar (px), for
   * the footer's rest; absent: the viewport.
   */
  view?: number;
  /**
   * The page's last section (the rise is keyed to it, whatever it is);
   * absent until it is measured.
   */
  riseSection?: { top: number; bottom: number } | null;
  /** The Return spacer; absent or zero height until it is built. */
  ret?: { top: number; height: number } | null;
  /** The Last spacer; its top is the wrap line. Absent or zero height: no wrap. */
  last?: { top: number; height: number } | null;
};

export type FlowRange = { start: number; end: number };

export type FlowTable = {
  /** S, px. */
  section: number;
  r0: number;
  /** The focused pack's rests, whole pixels, ascending. */
  rests: number[];
  rl: number;
  /** The paged stops [R0, rests..., RL], built once per table. */
  stops: readonly number[];
  /** The lineup exit starts here: the lineup rest RL. */
  exitStart: number;
  /** The end of the lineup exit (the free part starts). */
  exitEnd: number;
  /** The paged zone ends here (RL + S / 2). */
  edge: number;
  rise: FlowRange | null;
  ret: FlowRange | null;
  lastTop: number | null;
  lastHeight: number;
  /**
   * The end's rests, ascending: the footer in view (the end of the free
   * part), the chosen pack alone (the rise's end) and Last's top (the row
   * back, where a move there wraps). Empty without a measured last section
   * and a Last: the free part then runs on to the wrap.
   */
  ends: readonly number[];
};

export type FlowSpan = 'exit' | 'free' | 'rise' | 'ret' | 'last';

/** The flow position: paged (P, 0 = row, 1..n stops, n + 1 = lineup) or a free span's progress. */
export type FlowAt =
  | { zone: 'paged'; p: number }
  | { zone: 'free'; span: FlowSpan; t: number };

/**
 * The slots (in sections after R0) a variant with n stops rests on: evenly
 * over the six-slot band, first at slot 1 and last at slot 6, so the page
 * height and the lineup never depend on the chosen pack. One stop rests on
 * slot 1; none, nothing (both cases are undefined).
 */
export function flowSlots(n: number): number[] {
  const c = Math.floor(n);
  if (!(c >= 1)) return [];
  if (c === 1) return [1];
  const span = FLOW_DETAIL_SLOTS - 1;
  return Array.from({ length: c }, (_, j) => 1 + (j * span) / (c - 1));
}

/** The table for this geometry, or null when there is no panel to page by. */
export function flowTable(g: FlowGeometry): FlowTable | null {
  if (!(g.panel > 0) || !Number.isFinite(g.panel)) return null;
  const S = g.panel * FLOW_SECTION_PANELS;
  const r0 = g.top;
  // whole pixels, as the focus kit rounds its stops
  const rests = flowSlots(g.stops).map((s) => Math.round(r0 + s * S));
  const rl = Math.round(r0 + FLOW_LINEUP_SLOT * S);
  // the exit runs over the Lineup spacer: RL to RL + S, where the first section starts
  const exitStart = rl;
  const exitEnd = Math.round(rl + S);
  const vp = Math.max(0, g.viewport);
  let after = exitEnd;
  let rise: FlowRange | null = null;
  if (g.riseSection) {
    const s = g.riseSection;
    const start = Math.max(after, s.top - RISE_START_VIEWPORT * vp);
    const end = Math.max(start, s.bottom);
    rise = { start, end };
    after = end;
  }
  let ret: FlowRange | null = null;
  if (g.ret && g.ret.height > 0) {
    const start = Math.max(after, g.ret.top);
    ret = { start, end: start + g.ret.height };
    after = ret.end;
  }
  const hasLast = !!g.last && g.last.height > 0;
  const lastTop = hasLast ? Math.max(after, g.last!.top) : null;
  return {
    section: S,
    r0,
    rests,
    rl,
    stops: [r0, ...rests, rl],
    exitStart,
    exitEnd,
    edge: rl + S / 2,
    rise,
    ret,
    lastTop,
    lastHeight: hasLast ? g.last!.height : 0,
    ends: endRests(exitEnd, rise, lastTop, g.view ?? vp),
  };
}

/**
 * The end's rests: the footer's bottom at the bottom of the view (above the
 * rise start, so nothing rises over the footer at rest, and never above the
 * exit end), the rise's end (rounded down), Last's top; whole pixels but the wrap line,
 * each distinct from the one before.
 */
function endRests(
  exitEnd: number,
  rise: FlowRange | null,
  lastTop: number | null,
  view: number,
): number[] {
  if (!rise || lastTop === null) return [];
  const footer = Math.round(
    Math.max(exitEnd, Math.min(rise.start - 1, rise.end - Math.max(0, view))),
  );
  const out: number[] = [];
  // the pack's rest never past the rise's end: a pixel into Return would draw the others
  for (const y of [footer, Math.floor(rise.end), lastTop])
    if (out.length === 0 || y > out[out.length - 1]! + 0.5) out.push(y);
  return out;
}

/** The paged stops: [R0, rests..., RL] (the table's own list; do not mutate). */
export function flowStops(t: FlowTable): readonly number[] {
  return t.stops;
}

/** The fractional index of y in an ascending list (clamped to its ends). */
export function indexAt(y: number, stops: readonly number[]): number {
  const n = stops.length;
  if (n === 0 || y <= stops[0]!) return 0;
  for (let k = 0; k < n - 1; k++) {
    const a = stops[k]!;
    const b = stops[k + 1]!;
    if (y <= b) return k + (b > a ? (y - a) / (b - a) : 1);
  }
  return n - 1;
}

/** The scroll at a fractional index of an ascending list (the inverse of `indexAt`). */
export function positionAt(i: number, stops: readonly number[]): number {
  const n = stops.length;
  if (n === 0) return 0;
  if (!(i > 0)) return stops[0]!;
  if (i >= n - 1) return stops[n - 1]!;
  const k = Math.floor(i);
  const a = stops[k]!;
  return a + (stops[k + 1]! - a) * (i - k);
}

const progress = (y: number, a: number, b: number): number =>
  b > a ? clamp01((y - a) / (b - a)) : y >= a ? 1 : 0;

/** The flow position at a scroll. */
export function flowAt(scrollY: number, t: FlowTable): FlowAt {
  if (scrollY <= t.rl) return { zone: 'paged', p: indexAt(scrollY, t.stops) };
  if (scrollY <= t.exitEnd)
    return {
      zone: 'free',
      span: 'exit',
      t: progress(scrollY, t.exitStart, t.exitEnd),
    };
  if (t.lastTop !== null && scrollY >= t.lastTop)
    return {
      zone: 'free',
      span: 'last',
      t: progress(scrollY, t.lastTop, t.lastTop + t.lastHeight),
    };
  if (!t.rise || scrollY < t.rise.start)
    return {
      zone: 'free',
      span: 'free',
      t: t.rise ? progress(scrollY, t.exitEnd, t.rise.start) : 0,
    };
  if (!t.ret || scrollY < t.ret.start)
    return {
      zone: 'free',
      span: 'rise',
      t: progress(scrollY, t.rise.start, t.rise.end),
    };
  return {
    zone: 'free',
    span: 'ret',
    t: progress(scrollY, t.ret.start, t.ret.end),
  };
}

/**
 * The scroll for a flow position (the inverse of `flowAt`). A span the
 * table does not have lands on where it would start. Without a measured
 * rise the free span has no length, so its progress cannot be kept.
 */
export function flowPosition(at: FlowAt, t: FlowTable): number {
  if (at.zone === 'paged') return positionAt(at.p, t.stops);
  const x = clamp01(at.t);
  const along = (a: number, b: number) => a + (b - a) * x;
  const riseStart = t.rise?.start ?? t.exitEnd;
  const riseEnd = t.rise?.end ?? riseStart;
  switch (at.span) {
    case 'exit':
      return along(t.exitStart, t.exitEnd);
    case 'free':
      return along(t.exitEnd, riseStart);
    case 'rise':
      return along(riseStart, riseEnd);
    case 'ret':
      return t.ret ? along(t.ret.start, t.ret.end) : riseEnd;
    case 'last':
      return t.lastTop === null
        ? (t.ret?.end ?? riseEnd)
        : along(t.lastTop, t.lastTop + t.lastHeight);
  }
}

/**
 * The rise from the last section's live rect (viewport pixels): 0 when its
 * top reaches 0.35 of the viewport, 1 when its bottom reaches the top. It
 * reads only this section, so the height of the sections above never moves
 * it.
 */
export function riseProgress(
  rectTop: number,
  rectBottom: number,
  viewport: number,
): number {
  const start = RISE_START_VIEWPORT * Math.max(0, viewport);
  const length = start + Math.max(0, rectBottom - rectTop);
  if (!(length > 0)) return rectBottom <= 0 ? 1 : 0;
  return clamp01((start - rectTop) / length);
}

/** The return over the Return spacer's live rect: 0 at its top, 1 at its end. */
export function returnProgress(rectTop: number, height: number): number {
  if (!(height > 0)) return rectTop <= 0 ? 1 : 0;
  return clamp01((0 - rectTop) / height);
}

/**
 * What draws the 3D at P. At most two adjacent terms carry weight and the
 * weights sum to 1:
 * - `focus`: the focused view at F (0 is the row at rest);
 * - `lineup`: the tilted lineup, then its exit;
 * - `empty`: nothing drawn (the free content);
 * - `rise`: the chosen pack rising;
 * - `return`: the others sliding back to the row's rest (Last holds its end).
 */
export type FlowTerm = 'focus' | 'lineup' | 'empty' | 'rise' | 'return';

export type FlowTerms = {
  weights: Record<FlowTerm, number>;
  /** F for the focus term, 0..n (Closing during the hand-off). */
  focus: number;
  /** The hand-off h, Closing to the lineup, power1InOut of the local progress. */
  handoff: number;
  /** The lineup exit, 0..1. */
  exit: number;
  /** The rise, 0..1 (raw progress; the pose decides its own ease). */
  rise: number;
  /** The return, 0..1 (raw progress). */
  ret: number;
  /** The others' row spacing in row steps, 5 to 1 (hand-off and Return). */
  spread: number;
};

/** The terms at a flow position, for a pack with n stops (one result object per call). */
export function flowTerms(at: FlowAt, n: number): FlowTerms {
  const stops = Math.max(0, Math.floor(n));
  const r: FlowTerms = {
    weights: { focus: 0, lineup: 0, empty: 0, rise: 0, return: 0 },
    focus: stops,
    handoff: 1,
    exit: 1,
    rise: 0,
    ret: 0,
    spread: FLOW_SPREAD_TO,
  };
  const w = r.weights;
  if (at.zone === 'paged') {
    const p = Math.min(stops + 1, Math.max(0, at.p));
    r.exit = 0;
    if (p <= stops) {
      w.focus = 1;
      r.focus = p;
      r.handoff = 0;
      r.spread = FLOW_SPREAD_FROM;
      return r;
    }
    const h = power1InOut(p - stops);
    w.lineup = h;
    w.focus = 1 - h;
    r.handoff = h;
    r.spread = spreadAt(h);
    return r;
  }
  const x = clamp01(at.t);
  switch (at.span) {
    case 'exit':
      w.lineup = 1;
      r.exit = x;
      return r;
    case 'free':
      w.empty = 1;
      return r;
    case 'rise':
      w.rise = 1;
      r.rise = x;
      r.spread = FLOW_SPREAD_FROM;
      return r;
    case 'ret':
      w.return = 1;
      r.rise = 1;
      r.ret = x;
      r.spread = spreadAt(x);
      return r;
    case 'last':
      w.return = 1;
      r.rise = 1;
      r.ret = 1;
      return r;
  }
}

/**
 * The focused back is released once the hand-off passes this share of the
 * move from Closing to the lineup, and wanted again below it; it is printed only at rest, so never mid-move.
 */
export const BACK_RELEASE_AT = 0.5;

/**
 * The focused back is printed once the pack has rested at a stop this long:
 * the print (a 60-90 ms canvas job and upload) then never lands on a move's
 * last frame, nor between the gestures of a quick run through the stops.
 */
export const BACK_PRINT_REST_MS = 300;

/** Whether the focused pack's back is wanted at hand-off progress x (0 at Closing). */
export function focusBackWanted(x: number): boolean {
  return !(x >= BACK_RELEASE_AT);
}

/**
 * Whether the lineup's fronts are to be resident: from the rest on Closing
 * on (the hand-off fades them in from its first frame, so a front uploaded
 * mid-move would pop in at the fade it had reached), through the hand-off
 * and the exit; and, with no focus, while the row's own spin or exit runs.
 * `focus` is F, `stops` the focused pack's stop count (0: none).
 */
export function lineupResident(o: {
  focus: number;
  stops: number;
  spin: number;
  exit: number;
}): boolean {
  if (o.spin > 0 || o.exit > 0) return true;
  return o.stops > 0 && o.focus >= o.stops - 1e-3;
}

/** A lineup pack whose front was not drawable a moment ago fades in over this. */
export const LINEUP_APPEAR_MS = 300;

/**
 * A lineup pack's fade-in, `elapsed` ms after its front became drawable:
 * a texture that comes back mid-lineup (the stage let its packs go during a
 * long stay below) fades in rather than cutting in.
 */
export function lineupAppear(elapsed: number): number {
  return clamp01(elapsed / LINEUP_APPEAR_MS);
}

/** A section of the free part, in document scroll pixels. */
export type FlowSection = { top: number; height: number };

/**
 * The free part's place for a re-measure: the section
 * under the viewport's middle and the share of it there. Null above the
 * first section; past the last, its end.
 */
export function freeAnchor(
  y: number,
  sections: readonly FlowSection[],
  viewport: number,
): { i: number; frac: number } | null {
  const mid = y + Math.max(0, viewport) / 2;
  const n = sections.length;
  if (n === 0 || mid < sections[0]!.top) return null;
  for (let i = 0; i < n; i++) {
    const s = sections[i]!;
    if (mid < s.top + s.height || i === n - 1)
      return { i, frac: s.height > 0 ? clamp01((mid - s.top) / s.height) : 0 };
  }
  return null;
}

/** The scroll that puts the same share of the same section under the middle. */
export function freeAnchorY(
  a: { i: number; frac: number },
  sections: readonly FlowSection[],
  viewport: number,
): number {
  const s = sections[Math.min(a.i, sections.length - 1)];
  if (!s) return 0;
  return s.top + s.height * a.frac - Math.max(0, viewport) / 2;
}

/** The others' row spacing at progress x: 5 row steps falling to 1. */
export function spreadAt(x: number): number {
  return FLOW_SPREAD_FROM + (FLOW_SPREAD_TO - FLOW_SPREAD_FROM) * clamp01(x);
}

/**
 * The wrap: a downward movement (by any means) that ends at or below Last's
 * top; the result is the overshoot past the line, never more than this
 * movement (a page a re-measure left inside Last wraps on its next movement
 * down, keeping only that movement). Null: no wrap.
 */
export function wrapTarget(
  prevY: number,
  scrollY: number,
  lastTop: number | null,
): number | null {
  if (lastTop === null || !(scrollY > prevY) || scrollY < lastTop) return null;
  return Math.min(scrollY - lastTop, scrollY - prevY);
}

/**
 * The lap's state at a flow position: none in the paged part and
 * the exit; nothing drawn in the free span (`trim`: only the chosen pack
 * kept, see `lapTrim`); the rise and the return as read from their live
 * rects; Last holds the end.
 */
export function lapAt(
  at: FlowAt | null,
  live: { rise: number; ret: number },
  trim: boolean,
): StageLap | null {
  if (!at || at.zone === 'paged') return null;
  switch (at.span) {
    case 'exit':
      return null;
    case 'free':
      return { rise: 0, ret: 0, free: true, trim };
    case 'rise':
      return { rise: clamp01(live.rise), ret: 0, free: false, trim: false };
    case 'ret':
      return { rise: 1, ret: clamp01(live.ret), free: false, trim: false };
    case 'last':
      return LAP_END;
  }
}

/**
 * Whether two lap states draw the same: every field counts, the free span's
 * `trim` included (a normal scroll reaches the trim line inside the free
 * span, and a jump in can leave it set on the way back up).
 */
export function sameLap(
  a: Readonly<StageLap> | null,
  b: Readonly<StageLap> | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.rise === b.rise &&
    a.ret === b.ret &&
    a.free === b.free &&
    a.trim === b.trim
  );
}

/** The end of Return (Last, and the wrap's lock): the row at rest exactly. */
export const LAP_END: Readonly<StageLap> = Object.freeze({
  rise: 1,
  ret: 1,
  free: false,
  trim: false,
});

/** The free span's ends where every pack stays resident, in viewports. */
export const LAP_TRIM_MARGIN = 0.25;

/**
 * Whether only the chosen pack is kept: from a quarter viewport
 * past the exit end to a quarter viewport before the rise, so the way back up
 * to the lineup and the way on to the rise find their packs loaded (the
 * others are drawn only from Return on, and fade in if they come late).
 */
export function lapTrim(y: number, t: FlowTable, viewport: number): boolean {
  const m = LAP_TRIM_MARGIN * viewport;
  if (y < t.exitEnd + m) return false;
  return !t.rise || y < t.rise.start - m;
}

/** The locked scroll back to R0 after the wrap, ease-out cubic over 1.2 s. */
export function wrapScrollAt(
  elapsedMs: number,
  from: number,
  r0: number,
): number {
  return from + (r0 - from) * easeOutCubic(elapsedMs / WRAP_GUARD_MS);
}

/** The row UI's opacity after the wrap: 0 to 1 over 0.35 s. */
export function wrapUiOpacity(elapsedMs: number): number {
  return clamp01(elapsedMs / WRAP_UI_FADE_MS);
}
