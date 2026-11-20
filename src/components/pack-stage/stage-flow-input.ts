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
 * - the stop list ends at Closing: a down gesture there pages to the end of
 *   the Exit spacer (the opening line's top, where the free part starts),
 *   and the focused pack fades out over that move (`fade`, a function of
 *   the scroll); the lineup and its exit are built by later packages;
 * - a re-measure keeps the flow position P (a rotation never leaves the page
 *   off its section).
 * Touches that start in the free part stay the browser's own until the free
 * part's touch is built (work package 6); the wheel there is native except an
 * up notch that crosses the paged edge, which pages back to Closing.
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
  type FlowPagerFrame,
  type FlowPagerTable,
} from './stage-flow-pager';
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
  /** The focused pack's fade past its last stop: 0 shown, 1 gone (from the Exit spacer's top). */
  fade: number;
};

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
  frame(scrollY: number, now: number): FlowInputFrame;
  busy(): boolean;
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
  const pagerTable = (
    t: FlowTable,
    kinds: readonly string[],
  ): FlowPagerTable => ({
    stops: [t.r0, ...t.rests],
    kinds,
    exitEnd: t.exitEnd,
    edge: t.edge,
    lineup: false,
  });
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
  const stops = () => (table ? [table.r0, ...table.rests] : []);

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
    touchStart(x, y, scrollY, now, o) {
      arm();
      nativeTouch = pager.zone(scrollY) === 'free';
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
      // focus the centred pack, or back to the row when it cannot be (nearer
      // the row, the pager's own snap brings it back unfocused)
      const first = t ? (t.rests[0] ?? t.exitEnd) : 0;
      if (
        t &&
        !d.focused() &&
        f.zone === 'paged' &&
        y > (t.r0 + first) / 2 &&
        !(f.animating && f.target === 0)
      ) {
        if (d.enter()) build();
        else if (!pager.busy() && pager.goTo(0, y, now) === 'moved') {
          f = { ...f, target: 0, animating: true, idle: false };
        }
      }
      if (!t) return { ...f, at: null, focus: 0, fade: 0 };
      const at = flowAt(y, t);
      const n = t.rests.length;
      const last = n > 0 ? t.rests[n - 1]! : t.r0;
      const focus = at.zone === 'paged' ? Math.min(n, at.p) : n;
      // gone by the Exit spacer's top: the free content below it never comes
      // into view over the fading pack
      const fade =
        t.exitStart > last ? clamp01((y - last) / (t.exitStart - last)) : 0;
      return { ...f, at, focus, fade };
    },
    busy: () => pager.busy(),
  };
}
