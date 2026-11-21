/**
 * Pack stage: the full-page flow's input, as pure code. No DOM and no clock: the spin chunk passes the
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
 * - the stop list ends at the lineup rest RL: a down
 *   gesture at Closing pages to RL while the focused pack hands over to the
 *   tilted lineup (`handoff`, the local progress, a function of the
 *   scroll); a down gesture at RL pages through the lineup's exit
 *   (`exit`, from RL over the Lineup and Exit spacers, so it starts on the
 *   move's first frame) to the end of the Exit spacer, where the free part
 *   starts; a
 *   pack that cannot be focused keeps the row alone;
 * - a re-measure keeps the flow position P (a rotation never leaves the page
 *   off its section).
 * In the free part a vertical touch is the flow's (the page follows the
 * finger, then glides) and a sideways one the browser's; the wheel
 * there is native except an up notch that crosses the paged edge, which
 * pages back to the lineup. Crossing Last's top going down wraps to the row;
 * Home and Escape at the lineup take the same way back.
 */
import {
  flowAt,
  flowPosition,
  flowTable,
  freeAnchor,
  freeAnchorY,
  type FlowAt,
  type FlowSection,
  type FlowTable,
} from './stage-flow';
import {
  createFlowPager,
  flowPagerTable,
  type FlowKeyResult,
  type FlowPagerFrame,
  type FlowPagerTable,
} from './stage-flow-pager';
import { createFlowLine, type FlowLineFrame } from './stage-flow-line';
import { blockAt } from './stage-focus';
import { AXIS_LOCK_PX } from './stage-pager';
import { clamp01 } from './stage-spin-math';

/** The pick is carried this long after the lineup comes to rest (debounced 150 ms). */
export const LINE_PICK_MS = 150;

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
  /**
   * The lineup's row while a pack is focused: the row's track, its length
   * and the focused pack's index (null: no row to pick in).
   */
  line?(): { track: number; count: number; index: number } | null;
  /** The pick: the focused view is rebuilt for the pack at `index`; false: it could not be. */
  pick?(index: number): boolean;
  /** Whether the pack at `index` can be picked (focused). */
  canPick?(index: number): boolean;
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
  /** The Telegram section (the rise is keyed to it); null: not measured. */
  telegram?: { top: number; bottom: number } | null;
  /** The Return spacer; null or zero height: none. */
  ret?: { top: number; height: number } | null;
  /** The Last spacer (its top is the wrap line); null or zero height: no wrap. */
  last?: { top: number; height: number } | null;
  /**
   * The free part's sections in page order (the opening line, Just Pulled,
   * Telegram, Return, Last): a re-measure keeps the one under the middle.
   */
  sections?: readonly FlowSection[] | null;
};

export type FlowInputFrame = FlowPagerFrame & {
  /** The flow position at the scroll this frame ends on (null: no table). */
  at: FlowAt | null;
  /** The focus value F: P in the band, held at the last stop past it. */
  focus: number;
  /**
   * The hand-off from Closing to the lineup rest: the local
   * progress, 0 at Closing and above, 1 at RL and below (the pose eases it).
   */
  handoff: number;
  /** The lineup's exit from RL to the Exit spacer's end: 0 at RL and above, 1 at its end and below. */
  exit: number;
  /**
   * The page has left the details downwards: the free part, or past the
   * last stop by the text's own line (20% into the move below it, either
   * way, as `blockAt`). The address follows it.
   */
  past: boolean;
  /**
   * The lineup's pick while it moves (and on the frame it comes to rest):
   * the caller writes `track` to the row. Null: the row is not the line's.
   */
  line: FlowLineFrame | null;
};

/** What a key asks for. */
export type FlowKeyIntent =
  'next' | 'prev' | 'first' | 'last' | 'escape' | 'left' | 'right';

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
 * the last paged stop; Escape back to the row; ArrowLeft and ArrowRight pick
 * at the lineup (elsewhere the browser's). With Ctrl, Alt or Meta held a key
 * is the browser's.
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
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

/**
 * Where a page starts once the flow binds (a reload starts at the
 * row). A reload or a history load that left
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
  /**
   * A key: a move, swallowed, the browser's own, or the focused view's leave.
   * `repeat`: the key is held down; in the paged part a held paging key is
   * swallowed (one page per press).
   */
  key(
    intent: FlowKeyIntent,
    scrollY: number,
    now: number,
    repeat?: boolean,
  ): FlowKeyOutcome;
  /**
   * `strip`: a sideways touch here belongs to what it started on. `at`
   * (here and on the move and the end): the event's own time, for the free
   * part's release speed; `now`: when it was handled.
   */
  touchStart(
    x: number,
    y: number,
    scrollY: number,
    now: number,
    at: number,
    o?: { strip?: boolean },
  ): void;
  /** True: the caller cancels the touchmove. */
  touchMove(
    x: number,
    y: number,
    scrollY: number,
    now: number,
    at: number,
  ): boolean;
  /**
   * The scroll the last free-part touchmove asks for (the page follows the
   * finger): the caller writes it at once. Read once; null: nothing to write.
   */
  follow(): number | null;
  touchEnd(scrollY: number, now: number, at: number): void;
  /** The touch's tracking is dropped: nothing pages, the snap and the idle report come back. */
  touchCancel(): void;
  /** A mouse press (desktop); true: the lineup's drag may follow (the caller cancels it). */
  mouseDown(x: number, y: number, scrollY: number, now: number): boolean;
  /** True: the lineup is being dragged (the caller cancels the move). */
  mouseMove(x: number, y: number, now: number): boolean;
  mouseUp(now: number): void;
  frame(scrollY: number, now: number): FlowInputFrame;
  busy(): boolean;
  /** The last gesture was a down gesture at the row that no focusable pack could take. */
  refused(): boolean;
  /** The lineup's pick, for the debug read-out. */
  lineState(): {
    pos: number;
    index: number;
    moving: boolean;
    pending: boolean;
  };
}

/** A page this close to the row counts as on it. */
const SAME_PX = 0.5;

export function createFlowInput(d: FlowInputDeps): FlowInput {
  const pager = createFlowPager();
  let geo: FlowInputGeometry | null = null;
  let table: FlowTable | null = null;
  let kindsKey = '';
  /** The free-part follow not yet written (read once by `follow`). */
  let followTo: number | null = null;
  /**
   * The scroll the last frame ended on: a re-measure keeps the place from
   * here, since the browser may already have clamped the scroll it hands in
   * (a rotation lays out the shorter page before the resize listener runs).
   */
  let lastY: number | null = null;
  /** The lineup's endless pick. */
  const line = createFlowLine({ canPick: (i) => d.canPick?.(i) ?? true });
  /** A touch that may drag the lineup: where it landed. */
  let lineTouch: { x0: number } | null = null;
  /** A mouse press that may drag the lineup, and its locked axis. */
  let mouse: { x0: number; y0: number; axis: 'x' | 'y' | null } | null = null;
  /** The line has been taken by a gesture in this focus. */
  let lineUsed = false;
  /** The focused pack the line was last aligned with (its sync, or its last pick). */
  let lineFocus: number | null = null;
  /** When the line came to rest on a pack not yet carried (null: none). */
  let restAt: number | null = null;

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
    // (never during the wrap's lock: it lands on the row)
    if (!d.focused() && pager.busy() && !pager.locking() && d.enter()) build();
  };
  const stops = (): readonly number[] =>
    table ? (table.rests.length > 0 ? table.stops : [table.r0]) : [];

  /**
   * The lineup can be dragged: a pack is focused and its row known, the page
   * within half a section of the lineup rest, and no move playing.
   */
  const lineLive = (scrollY: number): boolean => {
    const t = table;
    if (!t || t.rests.length === 0 || !d.focused() || pager.busy())
      return false;
    if (!d.line?.()) return false;
    return Math.abs(scrollY - t.rl) <= t.section / 2;
  };
  /** The line takes the row as it rests (ignored while it moves). */
  const syncLine = () => {
    const l = d.line?.();
    if (!l) return;
    line.sync(l.track, l.count);
    lineUsed = true;
    lineFocus = l.index;
  };
  /** The chosen pack is not the focused one: carry it now. */
  const pickDue = (): number | null => {
    if (!lineUsed) return null;
    const l = d.line?.();
    // the focus ended, or another pack was focused by other means: the
    // line's pick no longer stands (the next gesture takes the row afresh)
    if (!l || l.index !== lineFocus) {
      lineUsed = false;
      restAt = null;
      return null;
    }
    const k = line.index();
    return k !== l.index ? k : null;
  };
  const carry = (k: number) => {
    restAt = null;
    if (d.pick?.(k)) lineFocus = k;
    // a pick that cannot be made is dropped, never retried frame by frame
    else lineUsed = false;
    build();
  };
  /** Before a vertical gesture: a pick not yet carried is carried at once. */
  const flush = () => {
    const k = pickDue();
    if (k !== null) carry(k);
  };

  return {
    measure(g, scrollY) {
      const old = table;
      const oldGeo = geo;
      // a new viewport or panel (a rotation, a resize): the place of the
      // last frame, since the browser may already have clamped the scroll it
      // hands in; a change of content only: the scroll as it is
      const resized =
        !!oldGeo &&
        !!g &&
        (oldGeo.panel !== g.panel || oldGeo.viewport !== g.viewport);
      const y0 = resized ? (lastY ?? scrollY) : scrollY;
      const was = old ? flowAt(y0, old) : null;
      geo = g;
      build(true);
      if (!old || !table || !was || pager.busy()) return null;
      // past the paged edge only a resize moves the page (content that grows
      // in the free part leaves it where the visitor is reading)
      if (!resized && y0 > old.edge) return null;
      // the free part (past the exit): the same share of the same section
      // under the viewport's middle; elsewhere the flow position P
      const from = oldGeo?.sections;
      const to = g?.sections;
      const a =
        was.zone === 'free' && was.span !== 'exit' && from?.length && to?.length
          ? freeAnchor(y0, from, oldGeo!.viewport)
          : null;
      const y = a ? freeAnchorY(a, to!, g!.viewport) : flowPosition(was, table);
      lastY = y;
      return Math.abs(y - scrollY) >= SAME_PX ? y : null;
    },
    table: () => table,
    stops,
    wheel(dy, dx, shift, scrollY, now) {
      // sideways at the lineup: one pack per gesture
      if ((shift || Math.abs(dx) > Math.abs(dy)) && lineLive(scrollY)) {
        syncLine();
        return line.wheel(shift && dx === 0 ? dy : dx, now);
      }
      // the row is held: no page moves under it
      if (line.held()) return true;
      flush();
      arm();
      const used = pager.wheel(dy, dx, shift, scrollY, now);
      entered();
      return used;
    },
    goTo(k, scrollY, now, ms) {
      flush();
      arm();
      const ok = pager.goTo(k, scrollY, now, ms) === 'moved';
      entered();
      return ok;
    },
    key(intent, scrollY, now, repeat = false) {
      if (intent === 'left' || intent === 'right') {
        if (!lineLive(scrollY)) return 'free';
        if (repeat) return 'swallowed';
        syncLine();
        line.step(intent === 'right' ? 1 : -1);
        return 'moved';
      }
      if (line.held()) return 'swallowed';
      flush();
      arm();
      if (!table) return 'free';
      if (pager.busy()) return 'swallowed';
      if (pager.zone(scrollY) === 'free') return 'free';
      if (repeat && intent !== 'escape') return 'swallowed';
      const s = stops();
      let k = 0;
      for (let j = 1; j < s.length; j++)
        if (Math.abs(scrollY - s[j]!) < Math.abs(scrollY - s[k]!)) k = j;
      const inDetails = d.focused() && k >= 1;
      // at the lineup Home and Escape go back to the row the way the wrap
      // does: the lineup unforms into the row with the chosen pack, no move
      // back through the stops
      const atLineup =
        inDetails && table.rests.length > 0 && k === s.length - 1;
      if (atLineup && (intent === 'first' || intent === 'escape'))
        return pager.home(scrollY, now);
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
    touchStart(x, y, scrollY, now, at, o) {
      arm();
      followTo = null;
      // a finger that lands during a move (one crossing the paged edge
      // included) is ignored by the pager: the move always lands
      lineTouch = lineLive(scrollY) ? { x0: x } : null;
      pager.touchStart(x, y, scrollY, now, at, o);
    },
    touchMove(x, y, scrollY, now, at) {
      const r = pager.touchMove(x, y, scrollY, now, at);
      followTo = r.scrollTo;
      if (r.axis === 'x' && lineTouch) {
        // the lineup follows the finger (from where it landed); the page stays
        if (!line.held()) {
          syncLine();
          line.grab(lineTouch.x0, now);
        }
        line.drag(x, now);
        return true;
      }
      return r.consumed;
    },
    follow() {
      const y = followTo;
      followTo = null;
      return y;
    },
    touchEnd(scrollY, now, at) {
      lineTouch = null;
      followTo = null;
      if (line.held()) {
        line.release(now);
        pager.touchCancel();
        return;
      }
      flush();
      arm();
      pager.touchEnd(scrollY, now, at);
      entered();
    },
    touchCancel() {
      followTo = null;
      lineTouch = null;
      if (line.held()) line.release(0, false);
      pager.touchCancel();
    },
    mouseDown(x, y, scrollY) {
      mouse = lineLive(scrollY) ? { x0: x, y0: y, axis: null } : null;
      return mouse !== null;
    },
    mouseMove(x, y, now) {
      const m = mouse;
      if (!m) return false;
      if (m.axis === null) {
        const dx = Math.abs(x - m.x0);
        const dy = Math.abs(y - m.y0);
        if (Math.max(dx, dy) < AXIS_LOCK_PX) return false;
        m.axis = dx > dy ? 'x' : 'y';
        if (m.axis === 'x') {
          syncLine();
          line.grab(m.x0, now);
        }
      }
      if (m.axis !== 'x') return false;
      line.drag(x, now);
      return true;
    },
    mouseUp(now) {
      mouse = null;
      if (line.held()) line.release(now);
    },
    frame(scrollY, now) {
      // the lineup's pick: it eases on its own (also under a vertical move),
      // and is carried once it has rested on a new pack for 150 ms
      let lf: FlowLineFrame | null = null;
      if (line.moving() || restAt !== null || pickDue() !== null) {
        const was = line.moving();
        lf = line.frame(now);
        if (!was && !lf.moving && restAt === null) lf = null;
        if (line.moving()) restAt = null;
        else if (pickDue() !== null) {
          restAt ??= now;
          if (now - restAt >= LINE_PICK_MS) carry(line.index());
        } else restAt = null;
      }
      const lineBusy = line.moving() || restAt !== null;
      build();
      let f = pager.frame(scrollY, now);
      const y = f.scrollTo ?? scrollY;
      lastY = y;
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
        !f.lock &&
        d.enter()
      )
        build();
      if (lineBusy) f = { ...f, idle: false };
      if (!t)
        return {
          ...f,
          at: null,
          focus: 0,
          handoff: 0,
          exit: 0,
          past: false,
          line: lf,
        };
      const at = flowAt(y, t);
      const n = t.rests.length;
      const focus = at.zone === 'paged' ? Math.min(n, at.p) : n;
      let handoff = 0;
      let exit = 0;
      if (n > 0) {
        if (at.zone === 'paged') handoff = clamp01(at.p - n);
        else {
          handoff = 1;
          exit = at.span === 'exit' ? at.t : 1;
        }
      }
      const past = at.zone === 'free' || blockAt(at.p, n + 1) > n;
      return { ...f, at, focus, handoff, exit, past, line: lf };
    },
    busy: () => pager.busy(),
    refused: () => pager.refused(),
    lineState: () => ({
      pos: line.pos(),
      index: line.index(),
      moving: line.moving(),
      // a pick not yet carried (at rest, its 150 ms not yet over)
      pending: restAt !== null || pickDue() !== null,
    }),
  };
}
