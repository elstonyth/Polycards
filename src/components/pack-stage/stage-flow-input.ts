/**
 * Pack stage: the full-page flow's input, as pure code (full-flow plan 2.2,
 * 2.3; work package 3a). No DOM and no clock: the spin chunk passes the
 * scroll and the time, and writes `scrollTo` back to the window each frame.
 *
 * It joins the one flow pager to the focused view:
 * - the table is built from live geometry and the stop list of the focused
 *   pack (or, before a focus, of the centred pack);
 * - a down gesture at the row focuses the centred pack and pages to Front;
 *   a pack that cannot be focused swallows it (nothing moves);
 * - a page that reaches the band by other means (the scrollbar, a key's
 *   native scroll) focuses the centred pack as well, or goes back to the row
 *   when it cannot be focused;
 * - the stop list ends at the lineup rest RL (work package 4): a down
 *   gesture at Closing pages to RL while the focused pack hands over to the
 *   tilted lineup (`handoff`, the local progress, a function of the
 *   scroll); a down gesture at RL pages through the lineup's exit
 *   (`exit`) to the end of the Exit spacer, where the free part starts; a
 *   pack that cannot be focused keeps the row alone;
 * - a re-measure keeps the flow position P (a rotation never leaves the page
 *   off its section).
 * Touches that start in the free part stay the browser's own until the free
 * part's touch is built (work package 6); the wheel there is native except an
 * up notch that crosses the paged edge, which pages back to the lineup.
 */
import {
  flowAt,
  flowPosition,
  flowTable,
  type FlowAt,
  type FlowTable,
} from './stage-flow';
import {
  createFlowPager,
  flowPagerTable,
  type FlowKeyResult,
  type FlowPagerFrame,
  type FlowPagerTable,
} from './stage-flow-pager';
import { blockAt } from './stage-focus';
import { clamp01 } from './stage-spin-math';

/** What the flow reads of the page. */
export type FlowInputDeps = {
  /** The centred pack's stop kinds, or null when it cannot be focused (now). */
  centreKinds(): readonly string[] | null;
  /** A pack is focused. */
  focused(): boolean;
  /** The focused pack's stop kinds. */
  kinds(): readonly string[];
  /** Focus the centred pack without paging (the flow pages); false: it cannot be. */
  enter(): boolean;
};

/** The live geometry in document scroll pixels. */
export type FlowInputGeometry = {
  /** The row rest R0. */
  top: number;
  /** The stage panel's height. */
  panel: number;
  viewport: number;
  /** The Exit spacer (its bottom is the opening line's top); null: computed. */
  exit?: { top: number; height: number } | null;
};

export type FlowInputFrame = FlowPagerFrame & {
  /** The flow position at the scroll this frame ends on (null: no table). */
  at: FlowAt | null;
  /** The focus value F: P in the band, held at the last stop past it. */
  focus: number;
  /**
   * The hand-off from Closing to the lineup rest (plan 2.4): the local
   * progress, 0 at Closing and above, 1 at RL and below (the pose eases it).
   */
  handoff: number;
  /** The lineup's exit over the Exit spacer: 0 above it, 1 at its end and below. */
  exit: number;
  /**
   * The page has left the details downwards: the free part, or past the
   * last stop by the text's own line (20% into the move below it, either
   * way, as `blockAt`). The address follows it (plan 2.8).
   */
  past: boolean;
};

/** What a key asks for (plan 2.10). */
export type FlowKeyIntent = 'next' | 'prev' | 'first' | 'last' | 'escape';

/**
 * What a key did: the pager's result, or `leave`: the caller runs the
 * focused view's leave (the text first, then the move home), which is how
 * the details go back to the row.
 */
export type FlowKeyOutcome = FlowKeyResult | 'leave';

type KeyLike = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};

/**
 * The flow's keys: ArrowDown, PageDown and Space go to the next stop;
 * ArrowUp, PageUp and Shift+Space to the previous; Home to the row; End to
 * the last paged stop; Escape back to the row. With Ctrl, Alt or Meta held a
 * key is the browser's.
 */
export function flowKeyIntent(e: KeyLike): FlowKeyIntent | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  switch (e.key) {
    case 'ArrowDown':
    case 'PageDown':
      return 'next';
    case 'ArrowUp':
    case 'PageUp':
      return 'prev';
    case ' ':
      return e.shiftKey ? 'prev' : 'next';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'Escape':
      return 'escape';
    default:
      return null;
  }
}

/**
 * Where a page starts once the flow binds (plan 2.8: a reload starts at the
 * row, as the reference always does). A reload or a history load that left
 * the page elsewhere goes to R0; a plain load is the visitor's own.
 */
export function flowLoadStart(
  type: string | undefined,
  scrollY: number,
  r0: number,
): number | null {
  if (type !== 'reload' && type !== 'back_forward') return null;
  return Math.abs(scrollY - r0) >= SAME_PX ? r0 : null;
}

export interface FlowInput {
  /**
   * A new geometry (null: the flow is off). Returns the scroll that keeps P
   * when the paged rests moved under a resting page, else null.
   */
  measure(g: FlowInputGeometry | null, scrollY: number): number | null;
  table(): FlowTable | null;
  /** The paged stops: the row, then the pack's rests. */
  stops(): readonly number[];
  wheel(
    dy: number,
    dx: number,
    shift: boolean,
    scrollY: number,
    now: number,
  ): boolean;
  /** Straight to stop k (the exit end is the index after the last stop). */
  goTo(k: number, scrollY: number, now: number, ms?: number): boolean;
  /** A key: a move, swallowed, the browser's own, or the focused view's leave. */
  key(intent: FlowKeyIntent, scrollY: number, now: number): FlowKeyOutcome;
  /** `strip`: a sideways touch here belongs to what it started on. */
  touchStart(
    x: number,
    y: number,
    scrollY: number,
    now: number,
    o?: { strip?: boolean },
  ): void;
  /** True: the caller cancels the touchmove. */
  touchMove(x: number, y: number, scrollY: number, now: number): boolean;
  touchEnd(scrollY: number, now: number): void;
  /** The touch's tracking is dropped: nothing pages, the snap and the idle report come back. */
  touchCancel(): void;
  frame(scrollY: number, now: number): FlowInputFrame;
  busy(): boolean;
  /** The last gesture was a down gesture at the row that no focusable pack could take. */
  refused(): boolean;
}

/** A page this close to the row counts as on it. */
const SAME_PX = 0.5;

export function createFlowInput(d: FlowInputDeps): FlowInput {
  const pager = createFlowPager();
  let geo: FlowInputGeometry | null = null;
  let table: FlowTable | null = null;
  let kindsKey = '';
  /** A touch that started in the free part: the browser's own. */
  let nativeTouch = false;

  const kindsNow = (): readonly string[] =>
    d.focused() ? d.kinds() : (d.centreKinds() ?? []);
  // a pack to focus pages on to the lineup; a pack that cannot be focused
  // keeps the row alone, so no snap rests an unfocused page on the lineup
  const pagerTable = (
    t: FlowTable,
    kinds: readonly string[],
  ): FlowPagerTable =>
    kinds.length > 0
      ? flowPagerTable(t, kinds)
      : {
          stops: [t.r0],
          kinds,
          exitEnd: t.exitEnd,
          edge: t.edge,
          lineup: false,
        };
  /** Rebuilds the table for these kinds (a new pack, or the first geometry). */
  const build = (force = false): void => {
    if (!geo) {
      table = null;
      kindsKey = '';
      pager.setTable(null);
      return;
    }
    const kinds = kindsNow();
    const key = kinds.join(',');
    if (!force && key === kindsKey && table) return;
    kindsKey = key;
    table = flowTable({ ...geo, stops: kinds.length });
    pager.setTable(table ? pagerTable(table, kinds) : null);
  };
  /** Before a gesture: the stop list of what it would page, and the entry rule. */
  const arm = () => {
    build();
    pager.setEntry(d.focused() || d.centreKinds() !== null);
  };
  /** After a gesture: a move that left the row focuses the centred pack. */
  const entered = () => {
    if (!d.focused() && pager.busy() && d.enter()) build();
  };
  const stops = (): readonly number[] =>
    table ? (table.rests.length > 0 ? table.stops : [table.r0]) : [];

  return {
    measure(g, scrollY) {
      const old = table;
      const was = old ? flowAt(scrollY, old) : null;
      geo = g;
      build(true);
      if (!old || !table || !was || pager.busy()) return null;
      if (scrollY > old.edge) return null;
      const y = flowPosition(was, table);
      return Math.abs(y - scrollY) >= SAME_PX ? y : null;
    },
    table: () => table,
    stops,
    wheel(dy, dx, shift, scrollY, now) {
      arm();
      const used = pager.wheel(dy, dx, shift, scrollY, now);
      entered();
      return used;
    },
    goTo(k, scrollY, now, ms) {
      arm();
      const ok = pager.goTo(k, scrollY, now, ms) === 'moved';
      entered();
      return ok;
    },
    key(intent, scrollY, now) {
      arm();
      if (!table) return 'free';
      if (pager.busy()) return 'swallowed';
      if (pager.zone(scrollY) === 'free') return 'free';
      const s = stops();
      let k = 0;
      for (let j = 1; j < s.length; j++)
        if (Math.abs(scrollY - s[j]!) < Math.abs(scrollY - s[k]!)) k = j;
      const inDetails = d.focused() && k >= 1;
      let r: FlowKeyResult;
      switch (intent) {
        case 'escape':
          return inDetails ? 'leave' : 'free';
        case 'first':
          return inDetails ? 'leave' : 'swallowed';
        case 'prev':
          if (inDetails && k <= 1) return 'leave';
          r = pager.step(-1, scrollY, now);
          break;
        case 'next':
          r = pager.step(1, scrollY, now);
          break;
        case 'last':
          // from the row only a pack that can be focused goes anywhere
          if (!d.focused() && d.centreKinds() === null) return 'swallowed';
          r = pager.goTo(s.length - 1, scrollY, now);
          break;
      }
      entered();
      return r;
    },
    touchStart(x, y, scrollY, now, o) {
      arm();
      // a finger that lands during a move (one crossing the paged edge
      // included) is the pager's, which ignores it: the move always lands
      nativeTouch = pager.zone(scrollY) === 'free' && !pager.busy();
      if (!nativeTouch) pager.touchStart(x, y, scrollY, now, o);
    },
    touchMove(x, y, scrollY, now) {
      if (nativeTouch) return false;
      return pager.touchMove(x, y, scrollY, now).consumed;
    },
    touchEnd(scrollY, now) {
      if (nativeTouch) {
        nativeTouch = false;
        return;
      }
      arm();
      pager.touchEnd(scrollY, now);
      entered();
    },
    touchCancel() {
      nativeTouch = false;
      pager.touchCancel();
    },
    frame(scrollY, now) {
      build();
      let f: FlowPagerFrame;
      if (nativeTouch && !pager.busy())
        f = {
          scrollTo: null,
          target: null,
          animating: false,
          idle: false,
          zone: pager.zone(scrollY),
        };
      else f = pager.frame(scrollY, now);
      const y = f.scrollTo ?? scrollY;
      const t = table;
      // the band reached with no pack focused, nearer a stop than the row:
      // focus the centred pack. A pack that cannot be focused has no rests
      // in the table (its stops are the row's alone), so the snap brings
      // the page back to the row unfocused.
      const first = t ? (t.rests[0] ?? t.exitEnd) : 0;
      if (
        t &&
        !d.focused() &&
        f.zone === 'paged' &&
        y > (t.r0 + first) / 2 &&
        !(f.animating && f.target === 0) &&
        d.enter()
      )
        build();
      if (!t)
        return { ...f, at: null, focus: 0, handoff: 0, exit: 0, past: false };
      const at = flowAt(y, t);
      const n = t.rests.length;
      const focus = at.zone === 'paged' ? Math.min(n, at.p) : n;
      let handoff = 0;
      let exit = 0;
      if (n > 0) {
        if (at.zone === 'paged') handoff = clamp01(at.p - n);
        else {
          handoff = 1;
          exit = at.span === 'lineup' ? 0 : at.span === 'exit' ? at.t : 1;
        }
      }
      const past = at.zone === 'free' || blockAt(at.p, n + 1) > n;
      return { ...f, at, focus, handoff, exit, past };
    },
    busy: () => pager.busy(),
    refused: () => pager.refused(),
  };
}
