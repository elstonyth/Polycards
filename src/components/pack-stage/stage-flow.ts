/**
 * Pack stage: the full-page flow model (full-flow plan sections 2.1, 2.4 to
 * 2.7). Pure: no DOM, no clock, no React, no three.js. Imported only by the
 * lazy stage chunks, never by the first load.
 *
 * The page is one table of scroll positions. The paged part: the row rest
 * R0, the focused pack's stops spread over a band of six sections, and the
 * lineup rest RL. The free part: the lineup holding through its own section
 * (the Lineup spacer), the lineup exit (the Exit spacer, ending where the
 * opening line's top meets the viewport top), the free content, the rise
 * (keyed to the Telegram section), Return and Last. One value, the flow
 * position P, is read from the scroll; every pose and text switch is a
 * function of P only, so scrolling back retraces the way down exactly.
 *
 * The table is rebuilt from live geometry on every re-measure (never cached
 * from a page height); a caller keeps P across a re-measure with
 * `flowAt` on the old table and `flowPosition` on the new one.
 */
import { power1InOut } from './stage-focus';
import { easeOutCubic } from './stage-spin-driver';
import { clamp01 } from './stage-spin-math';

/** One section: 1.25 panels (min-height 125svh) [code, D §A; P §A]. Equals CIAO_EXIT_PANELS [ours]. */
export const FLOW_SECTION_PANELS = 1.25;
/** The detail band: six slots, Front to Closing, for every variant [ours, plan 2.1]. */
export const FLOW_DETAIL_SLOTS = 6;
/** The lineup rest sits one section after the band: R0 + 7 S [ours, plan 2.1]. */
export const FLOW_LINEUP_SLOT = FLOW_DETAIL_SLOTS + 1;
/** The rise starts when the Telegram top reaches this share of the viewport [measured P §G: 296 of 844]. */
export const RISE_START_VIEWPORT = 0.35;
/** The others' row spacing at the start of the hand-off and of Return, in row steps [code, D §C; plan 2.4, 2.6]. */
export const FLOW_SPREAD_FROM = 5;
/** ... and at the end: the row's own step. */
export const FLOW_SPREAD_TO = 1;
/** The locked scroll back to the row after the wrap [code; measured D §H: lock 1.1-1.3 s]. */
export const WRAP_GUARD_MS = 1200;
/** The row UI fades back in over this after the wrap [measured D §H: back 0.06-0.40 s]. */
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
   * The Exit spacer (plan 2.1: after Row S, the band 6 S and Lineup S); its
   * bottom is the opening line's top, where the free part starts. Absent or
   * zero height: computed as RL + S to RL + 2 S, the spacers' CSS heights.
   * Same origin as `top` (document scroll pixels, as the caller derives R0).
   */
  exit?: { top: number; height: number } | null;
  /** The Telegram section; absent until it is measured. */
  telegram?: { top: number; bottom: number } | null;
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
  /** The lineup exit starts here (the Exit spacer's top). */
  exitStart: number;
  /** The end of the lineup exit (the free part starts). */
  exitEnd: number;
  /** The paged zone ends here (RL + S / 2) [ours, plan 2.2]. */
  edge: number;
  rise: FlowRange | null;
  ret: FlowRange | null;
  lastTop: number | null;
  lastHeight: number;
};

/** `lineup`: the lineup at rest through its own section, before the exit. */
export type FlowSpan = 'lineup' | 'exit' | 'free' | 'rise' | 'ret' | 'last';

/** The flow position: paged (P, 0 = row, 1..n stops, n + 1 = lineup) or a free span's progress. */
export type FlowAt =
  { zone: 'paged'; p: number } | { zone: 'free'; span: FlowSpan; t: number };

/**
 * The slots (in sections after R0) a variant with n stops rests on: evenly
 * over the six-slot band, first at slot 1 and last at slot 6, so the page
 * height and the lineup never depend on the chosen pack. One stop rests on
 * slot 1; none, nothing (both are cases the plan does not describe).
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
  // the layout is the source of truth; the CSS heights are the fallback
  const measured = !!g.exit && g.exit.height > 0;
  const exitStart = measured ? Math.max(rl, g.exit!.top) : Math.round(rl + S);
  const exitEnd = measured
    ? Math.max(exitStart, g.exit!.top + g.exit!.height)
    : Math.round(rl + 2 * S);
  const vp = Math.max(0, g.viewport);
  let after = exitEnd;
  let rise: FlowRange | null = null;
  if (g.telegram) {
    const start = Math.max(after, g.telegram.top - RISE_START_VIEWPORT * vp);
    const end = Math.max(start, g.telegram.bottom);
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
    lastTop: hasLast ? Math.max(after, g.last!.top) : null,
    lastHeight: hasLast ? g.last!.height : 0,
  };
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
  if (scrollY <= t.exitStart)
    return {
      zone: 'free',
      span: 'lineup',
      t: progress(scrollY, t.rl, t.exitStart),
    };
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
    case 'lineup':
      return along(t.rl, t.exitStart);
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
 * The rise from the Telegram section's live rect (viewport pixels): 0 when
 * its top reaches 0.35 of the viewport, 1 when its bottom reaches the top
 * [measured P §G]. It reads only this section, so Just Pulled's height
 * never moves it.
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
 * weights sum to 1 (this replaces canStartFocus and spinWhileFocused):
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
  /** The hand-off h, Closing to the lineup, power1InOut of the local progress (plan 2.4). */
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
    case 'lineup':
      w.lineup = 1;
      r.exit = 0;
      return r;
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
 * move from Closing to the lineup, and wanted again below it (full-flow plan
 * 2.12, risk 4); it is printed only at rest, so never mid-move.
 */
export const BACK_RELEASE_AT = 0.5;

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

/** A lineup pack whose front was not drawable a moment ago fades in over this [ours]. */
export const LINEUP_APPEAR_MS = 300;

/**
 * A lineup pack's fade-in, `elapsed` ms after its front became drawable:
 * a texture that comes back mid-lineup (the stage let its packs go during a
 * long stay below) fades in rather than cutting in.
 */
export function lineupAppear(elapsed: number): number {
  return clamp01(elapsed / LINEUP_APPEAR_MS);
}

/** The others' row spacing at progress x: 5 row steps falling to 1. */
export function spreadAt(x: number): number {
  return FLOW_SPREAD_FROM + (FLOW_SPREAD_TO - FLOW_SPREAD_FROM) * clamp01(x);
}

/**
 * The wrap: only when the scroll crosses Last's top going down (by any
 * means); the target keeps the overshoot. Null: no wrap.
 */
export function wrapTarget(
  prevY: number,
  scrollY: number,
  lastTop: number | null,
): number | null {
  if (lastTop === null) return null;
  return prevY < lastTop && scrollY >= lastTop ? scrollY - lastTop : null;
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
