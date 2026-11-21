/**
 * Pack stage: the scroll spin's lazily loaded chunk. The provider imports it at idle after hydration
 * (never under reduced motion) and shares it with the CSS tiles, so the first
 * load carries only the observables, the markup and the composition shell.
 *
 * The page is one flow: the panel sticks for the
 * whole flow root and everything after it scrolls over it. One pager pages
 * the row, the focused pack's stops and the move from Closing into the free
 * part: one wheel notch or swipe plays one 1.5 s ease-out cubic move, input
 * locked meanwhile, the page never following a held finger. A down gesture
 * at the row focuses the centred pack.
 *
 * Keys go through the same pager in the paged part; in the free
 * part they are the browser's. Focus landing in the row's own UI while the
 * page is off the row pages back to it. While bound, the page's scroll
 * restoration is manual and a reload starts at the row.
 */
import type { ReactNode } from 'react';
import type {
  FocusKey,
  SpinPanel,
  StageSpinKit,
  StageLap,
  StageSpinSource,
  StageState,
} from './contract';
import type { FocusRun } from './stage-focus-kit';
import type { StageTrackHandle } from './StageTrack';
import { STAGE_DESKTOP_QUERY } from './stage-gate';
import { stageAnnouncement } from './stage-filter';
import { tileVars } from './StageTile';
import { SLEEVE_TILE } from './stage-capsule-lean';
import { rowTilePacks, tilePose, tileSpinCtx } from './stage-row-tiles';
import { cancelFrame, frame, type FrameData } from './stage-motion';
import { composeOpacity, composePose } from './stage-pose-compose';
import { lineupCopies, lineupOpacity, lineupPose } from './stage-spin';
import {
  createFlowInput,
  flowKeyIntent,
  flowLoadStart,
  type FlowInputFrame,
} from './stage-flow-input';
import {
  LAP_END,
  WRAP_UI_FADE_MS,
  lapAt,
  lapTrim,
  returnProgress,
  riseProgress,
  sameLap,
} from './stage-flow';
import {
  HOLD_MAX_MS,
  createFocusLoad,
  createTouchGate,
  flowSwitch,
  holdStands,
  panelState,
} from './stage-flow-gate';
import { placeInstantly } from './stage-entry-cover';

/**
 * The measured stage a CSS row is projected into (host px; the art box is
 * untransformed), cached per host and dropped when the host resizes.
 */
type TileGeom = {
  desktop: boolean;
  step: number;
  artH: number;
  artW: number;
  cy: number;
  panel: SpinPanel;
};
const geoms = new WeakMap<HTMLElement, TileGeom | null>();
const watched = new WeakSet<HTMLElement>();

function geomOf(row: HTMLElement, host: HTMLElement): TileGeom | null {
  if (geoms.has(host)) return geoms.get(host) ?? null;
  if (!watched.has(host)) {
    watched.add(host);
    new ResizeObserver(() => geoms.delete(host)).observe(host);
  }
  const art = row.querySelector<HTMLElement>('[data-stage-art]');
  const tile = row.firstElementChild as HTMLElement | null;
  const h = host.getBoundingClientRect();
  const a = art?.getBoundingClientRect();
  let g: TileGeom | null = null;
  if (a && a.height > 0 && tile && tile.offsetWidth > 0 && h.height > 0) {
    const cy = a.top + a.height / 2 - h.top;
    g = {
      desktop: window.matchMedia(STAGE_DESKTOP_QUERY).matches,
      step: tile.offsetWidth,
      artH: a.height,
      artW: a.width,
      cy,
      panel: {
        w: host.clientWidth,
        h: host.clientHeight,
        anchorY: host.clientHeight > 0 ? cy / host.clientHeight : 0.5,
        viewH: window.innerHeight,
      },
    };
  }
  geoms.set(host, g);
  return g;
}

/**
 * The picture is the front: at a back stop it holds the last front-facing
 * pose (no turn, no lie-down), and the stop's block carries the back's facts.
 */
const heldKeys = new WeakMap<readonly FocusKey[], FocusKey[]>();
function frontKeys(keys: readonly FocusKey[]): FocusKey[] {
  let out = heldKeys.get(keys);
  if (!out) {
    let last: FocusKey | undefined;
    out = keys.map((k) => {
      if (k.face !== 'back') return (last = k);
      return last
        ? { ...last, kind: k.kind }
        : { ...k, face: 'front', ry: 0, rz: 0, on: 0 };
    });
    heldKeys.set(keys, out);
  }
  return out;
}

const fmt = (v: number) => String(Math.round(v * 10000) / 10000);

export const SPIN_KIT: StageSpinKit = {
  compose: composePose,
  spinPose: lineupPose,
  spinOpacity: lineupOpacity,
  copies: lineupCopies,
  paintTiles(row, host, packs, state, cyArt) {
    const g = geomOf(row, host);
    if (!g) return false;
    const count = packs.length;
    const p = g.desktop ? 'd' : 'm';
    const l = { cx: 0, cy: g.cy, step: g.step, artH: g.artH, artW: g.artW };
    const tiles = row.children;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i] as HTMLElement;
      const pack = packs[i] ?? SLEEVE_TILE;
      const soldOut = pack.soldOut;
      const capsule = pack.ticket;
      // step 1's vars for both breakpoints (labels, the other breakpoint)...
      const vars = tileVars(i, state, soldOut, cyArt, capsule);
      // ...then the breakpoint in use posed as the canvas draws it
      const ctx = tileSpinCtx(count, pack, state.exit, g.panel);
      // focused: the focus term, keyed to the panel (the picture is the
      // front, so a back stop shows it until the 3D back is drawn)
      const fo = state.focus > 0 ? state.focusOn : null;
      let lf = l;
      if (fo) {
        const img = tile.querySelector('img');
        const fit =
          img && img.naturalWidth > 0 && img.naturalHeight > 0
            ? Math.min(
                1,
                g.artW / g.artH / (img.naturalWidth / img.naturalHeight),
              )
            : 1;
        lf = { ...l, cx: g.panel.w / 2 };
        ctx.focus = {
          ...fo.ctx,
          keys: frontKeys(fo.ctx.keys),
          panel: { w: g.panel.w, h: g.panel.h },
          anchorY: g.panel.anchorY,
          backW: 0,
          fit,
        };
        ctx.focusTerm = fo.term;
      }
      const pose = tilePose(state, i, lf, g.desktop, pack, ctx);
      const op = composeOpacity(state, i, g.desktop, count, ctx);
      const k = 1 / g.artH;
      vars[`--${p}-dx`] = fmt((pose.dx + pose.fx * g.panel.w) * k);
      vars[`--${p}-dy`] = fmt((pose.dy + pose.fy * g.panel.h) * k);
      vars[`--${p}-z`] = fmt(pose.z * k);
      vars[`--${p}-rx`] = fmt(pose.rotX);
      vars[`--${p}-ry`] = fmt(pose.rotY);
      vars[`--${p}-rz`] = fmt(pose.rotZ);
      vars[`--${p}-s`] = fmt(pose.scale);
      vars[`--${p}-dim`] = fmt(pose.dim);
      vars[`--${p}-op`] = fmt(op);
      vars[`--${p}-pe`] = op > 0.5 ? 'auto' : 'none';
      for (const key in vars) tile.style.setProperty(key, vars[key] ?? '');
    }
    return true;
  },
};

/** What the provider lends the driver. */
export type SpinHost = {
  /**
   * The stage: its state and wake (the focused view drives them) and its
   * motion values (the row's spin and exit stay at 0 on this page).
   */
  stage: {
    state: StageState;
    wake(): void;
    /**
     * Whether the 3D is to be drawn at all: false while the focused pack is
     * faded out past Closing (the engine sleeps and, after a while, lets its
     * packs go); true again on the way back up.
     */
    show?(on: boolean): void;
    values: {
      spin: { set(v: number): void };
      exit: { set(v: number): void };
    } & Record<string, unknown>;
  };
  /** Renders the focused view's blocks over the panel. */
  ui?: (node: ReactNode) => void;
  /** The shown row's track (the lineup's pick moves it and selects its pack). */
  row?: () => StageTrackHandle | null;
};

export type SpinControl = {
  /** The page's flow, or null (unbound). */
  bind(src: StageSpinSource | null): void;
  wake(): void;
  stop(): void;
};

/** The element, or one above it in the page's sections, scrolls sideways. */
function sideScroller(el: Element | null): boolean {
  // only the page's own sections (the row under the spacers is not one)
  if (!el?.closest('[data-flow-section]')) return false;
  for (
    let e: Element | null = el;
    e && !e.hasAttribute('data-home-flow');
    e = e.parentElement
  ) {
    if (e.scrollWidth <= e.clientWidth + 1) continue;
    const o = getComputedStyle(e).overflowX;
    if (o === 'auto' || o === 'scroll') return true;
  }
  return false;
}

/** A wheel delta in px, whatever unit the device reports. */
function wheelPx(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16;
  if (e.deltaMode === 2) return e.deltaY * window.innerHeight;
  return e.deltaY;
}

/**
 * Starts the flow's driver: non-passive wheel and touch listeners (paging
 * cancels the native scroll), one frame loop that reads the scroll, writes it
 * while a move plays and hands the focus value to the focused view; it
 * sleeps at rest. For the bound flow it measures the table (the site
 * header's and the tab bar's heights make the panel one screen) and sets
 * data-flow-on, which pins the panel and gives the spacers their height.
 */
export function startSpin(host: SpinHost): SpinControl {
  const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let src: StageSpinSource | null = null;
  let looping = false;
  let wokeAt = 0;
  let unbindPage: (() => void) | null = null;
  const now = () => performance.now();
  const stage = host.stage;
  stage.values.spin.set(0);
  stage.values.exit.set(0);
  /** The focused view (its chunk loads at idle after this one, or at a tap). */
  let focus: FocusRun | null = null;
  const centre = () => Math.round(stage.state.track);
  const input = createFlowInput({
    centreKinds: () => focus?.kindsAt(centre()) ?? null,
    focused: () => !!focus?.active(),
    kinds: () => focus?.kinds() ?? [],
    enter: () => !!focus?.enter(centre(), { how: 'scroll', page: false }),
    // the lineup's endless pick: the shown row, while focused
    line: () => {
      const r = host.row?.();
      const fo = stage.state.focusOn;
      if (!r || !fo || !focus?.active() || r.packs.length === 0) return null;
      return {
        track: r.track.get(),
        count: r.packs.length,
        index: fo.ctx.index,
      };
    },
    pick: (i) => {
      if (!focus?.pick(i)) return false;
      announce(i);
      return true;
    },
    canPick: (i) => !!focus?.kindsAt(i),
  });
  const flowOn = () => !!src?.flow.hasAttribute('data-flow-on');

  /** The site header's height: the panel pins under it. */
  const headerHeight = () =>
    document.querySelector<HTMLElement>('header')?.offsetHeight ?? 0;
  /** The row rest R0 for this flow: its top under the site header. */
  const rowTop = (s: StageSpinSource) =>
    Math.max(
      0,
      Math.round(
        s.flow.getBoundingClientRect().top + window.scrollY - headerHeight(),
      ),
    );
  const measure = () => {
    if (!src) return;
    const tabBar = document.querySelector<HTMLElement>('nav.fixed.bottom-0');
    const top = headerHeight();
    const bottom = tabBar && tabBar.offsetHeight > 0 ? tabBar.offsetHeight : 0;
    src.flow.style.setProperty('--flow-top', `${top}px`);
    src.flow.style.setProperty('--flow-bottom', `${bottom}px`);
    // The flow is switched on only while the visitor is still at the row,
    // so a page already scrolled down never jumps.
    const r0 = rowTop(src);
    const panel = src.panel.getBoundingClientRect().height;
    const was = flowOn();
    // off while the focused view's chunk cannot be had: plain scrolling
    const on = flowSwitch({
      reduced: rmq.matches,
      empty: src.empty,
      focusFailed: !host.ui || fload.failed(),
      was,
      scrollY: window.scrollY,
      r0,
      panel,
    });
    if (on !== was) {
      src.flow.toggleAttribute('data-flow-on', on);
      // Return and Last take their height with the flow
      src.flow.toggleAttribute('data-flow-return', on);
      src.flow.toggleAttribute('data-flow-last', on);
      if (!on) clearPast(src);
      restore(on);
    }
    // the Exit spacer, measured: its bottom is where the free part starts
    const ex = on
      ? src.flow
          .querySelector<HTMLElement>("[data-flow-spacer='exit']")
          ?.getBoundingClientRect()
      : undefined;
    const exit =
      ex && ex.height > 0
        ? { top: ex.top + window.scrollY - top, height: ex.height }
        : null;
    // the rise, Return and Last, in the same origin (scroll under the header)
    const rectOf = (el: HTMLElement | null) => {
      const r = on && el ? el.getBoundingClientRect() : null;
      return r ? { top: r.top + window.scrollY - top, height: r.height } : null;
    };
    tgEl = src.flow.querySelector<HTMLElement>(
      "[data-flow-section='telegram']",
    );
    retEl = src.flow.querySelector<HTMLElement>("[data-flow-spacer='return']");
    const tg = rectOf(tgEl);
    const keep = input.measure(
      on
        ? {
            top: r0,
            panel,
            viewport: window.innerHeight,
            exit,
            telegram: tg ? { top: tg.top, bottom: tg.top + tg.height } : null,
            ret: rectOf(retEl),
            last: rectOf(
              src.flow.querySelector<HTMLElement>("[data-flow-spacer='last']"),
            ),
            // the free part's sections, in page order (a re-measure keeps
            // the one under the viewport's middle)
            sections: Array.from(
              src.flow.querySelectorAll<HTMLElement>(
                "[data-flow-section],[data-flow-spacer='return'],[data-flow-spacer='last']",
              ),
            )
              .map(rectOf)
              .filter((r): r is { top: number; height: number } => r !== null),
          }
        : null,
      window.scrollY,
    );
    if (keep !== null) window.scrollTo(0, keep);
    wake();
  };

  /**
   * The panel past Closing: the focused pack hands over to
   * the tilted lineup and its exit (the stage's spin and exit, read from the
   * scroll while a pack is focused); the stop text leaves on its own line
   * (data-flow-past); the panel takes no taps from the hand-off's first
   * frame, and is hidden, with the 3D not drawn, in the free part.
   */
  let shownSpin = -1;
  let shownExit = -1;
  let shownPast = false;
  let hidden = false;
  let inert = false;
  let lapOn = false;
  /** The Telegram section and the Return spacer: the lap reads their live rects. */
  let tgEl: HTMLElement | null = null;
  let retEl: HTMLElement | null = null;
  /** The rise and the return from the live rects (viewport under the header). */
  const liveLap = () => {
    const top = headerHeight();
    const vh = window.innerHeight;
    const a = tgEl?.getBoundingClientRect();
    const b = retEl?.getBoundingClientRect();
    return {
      rise: a ? riseProgress(a.top - top, a.bottom - top, vh) : 0,
      ret: b ? returnProgress(b.top - top, b.height) : 0,
    };
  };
  /** The lap's state in the stage (the runtime and the tiles redraw on it). */
  const setLap = (next: StageLap | null) => {
    if (sameLap(stage.state.lap ?? null, next)) return;
    stage.state.lap = next;
    stage.wake();
    if (focus) paintRow();
  };
  /** The Home lock from the lineup: the lineup unforms into the row with the scroll. */
  const homeSpin = (y: number): number => {
    const t = input.table();
    if (!t || !(t.rl > t.r0)) return 0;
    return Math.min(1, Math.max(0, (y - t.r0) / (t.rl - t.r0)));
  };
  const setPanel = (f: FlowInputFrame, y: number) => {
    const s = src;
    const t = input.table();
    if (!s || !t) return;
    const on = !!focus?.active();
    const p = panelState(
      on ? f.handoff : 0,
      y,
      t.exitEnd,
      t.rise?.start ?? null,
      // an unfocused page past the paged edge (a jump, the focus not had):
      // never during a lock, whose release leaves it unfocused on purpose
      on || f.lock ? null : t.edge,
    );
    // the wrap's lock holds the end of Return (the row at rest exactly), so
    // packs that come back during it fade in rather than cut in
    const lap =
      f.lock === 'wrap'
        ? LAP_END
        : p.free || p.lap
          ? lapAt(f.at, liveLap(), p.free && lapTrim(y, t, window.innerHeight))
          : null;
    setLap(lap);
    if (p.lap !== lapOn) {
      lapOn = p.lap;
      s.flow.toggleAttribute('data-flow-lap', p.lap);
    }
    // the free span keeps the lineup's values (its residency, no focused
    // back); the rise, Return and Last are the row's
    const rowValues = !lap || lap.free;
    const sp =
      f.lock === 'home' ? homeSpin(y) : on && rowValues ? f.handoff : 0;
    const ex = on && rowValues ? f.exit : 0;
    if (sp !== shownSpin) {
      shownSpin = sp;
      stage.values.spin.set(sp);
    }
    if (ex !== shownExit) {
      shownExit = ex;
      stage.values.exit.set(ex);
    }
    const past = on && f.past;
    if (past !== shownPast) {
      shownPast = past;
      s.flow.toggleAttribute('data-flow-past', past);
    }
    if (p.free !== hidden) {
      hidden = p.free;
      s.flow.toggleAttribute('data-flow-free', p.free);
    }
    // nothing in the panel takes a tap while a lock runs
    const isInert = p.inert || sp > 0 || !!f.lock;
    if (isInert !== inert) {
      inert = isInert;
      s.wrap.inert = isInert;
    }
  };
  /**
   * The lap ends: on the wrap frame, or Home or Escape at the
   * lineup. The row shows the chosen pack, the focus ends where it is (no
   * move, no history: past the details the address is the base path
   * already), and the row's UI fades back in over 0.35 s.
   */
  let wrapFade: number | null = null;
  /** The row UI fades back in over 0.35 s (data-flow-wrap, for that while). */
  const fadeUiIn = (s: StageSpinSource) => {
    s.flow.removeAttribute('data-flow-home');
    s.flow.setAttribute('data-flow-wrap', '');
    if (wrapFade !== null) window.clearTimeout(wrapFade);
    wrapFade = window.setTimeout(() => {
      wrapFade = null;
      s.flow.removeAttribute('data-flow-wrap');
    }, WRAP_UI_FADE_MS + 50);
  };
  /** The lock the last frame ran (its end brings Home's row UI back). */
  let lockWas: FlowInputFrame['lock'] = null;
  const endLap = (kind: FlowInputFrame['lock']) => {
    const s = src;
    if (!s) return;
    // the pack the lap drew (round(track)), the chosen one
    const index = centre();
    setLap(kind === 'wrap' ? LAP_END : null);
    if (lapOn) {
      lapOn = false;
      s.flow.removeAttribute('data-flow-lap');
    }
    const r = host.row?.();
    if (r && index >= 0 && index < r.packs.length) {
      if (r.track.get() !== index) r.track.set(index);
      r.go(index);
    }
    focus?.release();
    // the wrap: the row UI fades in from the wrap; Home: once the lineup
    // has unformed into the row (the lock's end)
    if (kind === 'home') s.flow.setAttribute('data-flow-home', '');
    else fadeUiIn(s);
  };
  /** Back to the panel as the row shows it (the flow off or unbound). */
  const clearPast = (s: StageSpinSource) => {
    s.flow.removeAttribute('data-flow-free');
    s.flow.removeAttribute('data-flow-past');
    s.flow.removeAttribute('data-flow-lap');
    s.flow.removeAttribute('data-flow-home');
    lapOn = false;
    setLap(null);
    s.wrap.inert = false;
    shownPast = false;
    if (shownSpin !== 0) stage.values.spin.set(0);
    if (shownExit !== 0) stage.values.exit.set(0);
    shownSpin = 0;
    shownExit = 0;
    hidden = false;
    inert = false;
  };

  // Only gestures inside the flow (or on the bare page or the site header)
  // page it: sheets, dialogs and the tab bar keep their own scrolling.
  // While a pack is focused every gesture outside a dialog is the flow's.
  const armed = (t: EventTarget | null): boolean => {
    if (inDialog(t)) return false;
    if (focus?.active()) return true;
    if (!(t instanceof Node)) return false;
    if (src?.flow.contains(t)) return true;
    if (t === document.body || t === document.documentElement) return true;
    const e = t instanceof Element ? t : t.parentElement;
    return !!e?.closest('header');
  };

  /** ?debug=1 only: [time, scrollY after the write, P] per frame, and gesture times. */
  let trace: number[][] | null = null;
  let gestures: number[] | null = null;

  const tick = (data: FrameData) => {
    const t = data.timestamp;
    if (!src || !flowOn()) {
      if (t - wokeAt > 250) stopLoop();
      return;
    }
    const f = input.frame(window.scrollY, t);
    if (f.line) moveRow(f.line.track, f.line.moving ? null : f.line.index);
    if (f.scrollTo !== null && Math.abs(f.scrollTo - window.scrollY) >= 0.5)
      window.scrollTo(0, f.scrollTo);
    // the wrap's (or Home's) first frame: the row comes back before it paints
    if (f.wrap === 0) endLap(f.lock);
    if (lockWas === 'home' && !f.lock && src) fadeUiIn(src);
    lockWas = f.lock ?? null;
    const y = window.scrollY;
    const p =
      f.at === null
        ? 0
        : f.at.zone === 'paged'
          ? f.at.p
          : f.focus + f.handoff + f.exit;
    if (trace && trace.push([t, y, p]) > 4000) trace.splice(0, 2000);
    setPanel(f, y);
    const rest = focus?.active()
      ? focus.frame(t, {
          focus: f.focus,
          target: f.target,
          animating: f.animating,
          idle: f.idle,
          past: f.past,
          handoff: f.handoff,
        })
      : true;
    if (f.idle && rest && t - wokeAt > 250) stopLoop();
  };
  /**
   * The lineup's pick moves the shown row's track (the canvas and the tiles
   * follow it); once it rests, the row selects that pack (its info block).
   * A pick that is carried is named by a polite region outside the inert
   * panel (made when the flow binds, so its first words are read).
   */
  let live: HTMLElement | null = null;
  const moveRow = (track: number, rested: number | null) => {
    const r = host.row?.();
    if (!r) return;
    if (r.track.get() !== track) r.track.set(track);
    if (rested !== null) r.go(rested);
  };
  const announce = (i: number) => {
    const r = host.row?.();
    const p = r?.packs[i];
    if (r && p && live)
      live.textContent = stageAnnouncement(p, i, r.packs.length);
  };
  const stopLoop = () => {
    if (!looping) return;
    cancelFrame(tick);
    looping = false;
  };
  function wake() {
    wokeAt = now();
    if (looping) return;
    looping = true;
    frame.update(tick, true);
  }

  /** Input that belongs to a dialog (the card overlay, a sheet). */
  function inDialog(t: EventTarget | null): boolean {
    return (
      !!(t instanceof Element && t.closest('[role="dialog"]')) ||
      !!document.querySelector('[role="dialog"][aria-modal="true"]')
    );
  }
  /** The focused view is leaving: every gesture waits for it. */
  const held = () => !!focus?.leaving();
  /** The focused view's chunk failed: any later gesture tries it again. */
  const retry = () => {
    if (!focus && fload.failed()) void loadFocus();
  };
  /** Where a held gesture was made: the shown tab and its centred pack. */
  const where = (): string => {
    const panel = src?.panel.querySelector<HTMLElement>(
      '[data-stage-panel]:not([hidden])',
    );
    const tile = panel?.querySelector<HTMLElement>(
      `[data-stage-tile][data-index="${centre()}"]`,
    );
    return `${panel?.dataset.stagePanel ?? ''}|${tile?.dataset.packId ?? ''}`;
  };
  /** A down gesture at the row before the focused view has loaded: kept for it. */
  const downHeld = () => {
    if (!focus && input.refused()) fload.holdDown(now(), where());
  };
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return;
    retry();
    if (!flowOn() || !armed(e.target)) return;
    if (held()) {
      e.preventDefault();
      return;
    }
    // a down notch at the row before the focused view has loaded: load it
    if (!focus) void loadFocus();
    gestures?.push(now());
    if (input.wheel(wheelPx(e), e.deltaX, e.shiftKey, window.scrollY, now()))
      e.preventDefault();
    downHeld();
    wake();
  };
  const touch = createTouchGate(input, held);
  const onTouchStart = (e: TouchEvent) => {
    retry();
    const p = e.touches[0];
    const ours = flowOn() && !!p && armed(e.target);
    if (ours && !focus) void loadFocus();
    const el = e.target instanceof Element ? e.target : null;
    // a sideways touch on the Top Hits strip, or on the row at rest, is
    // theirs; a touch on a sideways scroller in the page below (the live
    // ticker) is the browser's whichever way it goes
    const strip =
      !!el?.closest('[data-focus-strip]') ||
      (!focus?.active() && !!el?.closest('[data-stage-viewport]')) ||
      sideScroller(el);
    const x = p?.clientX ?? 0;
    const y = p?.clientY ?? 0;
    const t = now();
    if (
      touch.start(e.touches.length, ours, x, y, window.scrollY, t, {
        strip,
        at: e.timeStamp,
      })
    )
      wake();
  };
  const onTouchMove = (e: TouchEvent) => {
    const p = e.touches[0];
    if (!p) return;
    const t = now();
    if (
      touch.move(
        e.touches.length,
        p.clientX,
        p.clientY,
        window.scrollY,
        t,
        e.timeStamp,
      ) &&
      e.cancelable
    )
      e.preventDefault();
    // the free part: the page follows the finger
    const to = input.follow();
    if (to !== null) {
      window.scrollTo(0, to);
      wake();
    }
  };
  const onTouchEnd = (e: TouchEvent) => {
    const t = now();
    if (touch.end(window.scrollY, t, e.timeStamp)) {
      gestures?.push(now());
      downHeld();
    }
    wake();
  };
  // a touch the system takes (a gesture, a dialog) is dropped, never a release
  const onTouchCancel = () => {
    touch.cancel();
    wake();
  };
  // The lineup's mouse drag (desktop): the panel is inert there, so the
  // window listens; a press on a control or in a dialog is not a drag.
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !flowOn()) return;
    if (inDialog(e.target)) return;
    const el = e.target instanceof Element ? e.target : null;
    if (
      el?.closest(
        'header,nav,a,button,input,select,textarea,label,summary,[role="button"],[tabindex]:not([tabindex="-1"])',
      )
    )
      return;
    if (input.mouseDown(e.clientX, e.clientY, window.scrollY, now())) {
      e.preventDefault();
      wake();
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    // the button is up (its release was lost): the drag ends here
    if ((e.buttons & 1) === 0) {
      input.mouseUp(now());
      return;
    }
    if (input.mouseMove(e.clientX, e.clientY, now())) {
      e.preventDefault();
      wake();
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    input.mouseUp(now());
    wake();
  };
  const active = { passive: false } as const;
  const quiet = { passive: true } as const;
  window.addEventListener('wheel', onWheel, active);
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('touchstart', onTouchStart, quiet);
  window.addEventListener('touchmove', onTouchMove, active);
  window.addEventListener('touchend', onTouchEnd, quiet);
  window.addEventListener('touchcancel', onTouchCancel, quiet);
  window.addEventListener('scroll', onScroll, quiet);
  window.addEventListener('resize', measure, quiet);
  rmq.addEventListener('change', measure);

  // ---- The focused view ----
  const paintRow = () => {
    const panel = src?.panel;
    if (!panel) return;
    const row = panel.querySelector<HTMLElement>(
      '[data-stage-panel]:not([hidden]) [data-stage-row]',
    );
    if (!row) return;
    const tiles = Array.from(row.children) as HTMLElement[];
    // the capsule flag from the row on show (the tiles carry only names)
    const packs = rowTilePacks(
      tiles.map((t) => t.getAttribute('aria-label')),
      host.row?.()?.packs,
    );
    const art = row.querySelector<HTMLElement>('[data-stage-art]');
    const a = art?.getBoundingClientRect();
    const h = panel.getBoundingClientRect();
    const cyArt =
      a && a.height > 0 ? (a.top + a.height / 2 - h.top) / a.height : 0;
    SPIN_KIT.paintTiles(row, panel, packs, stage.state, cyArt);
  };
  const go = (k: number, o?: { from?: number; ms?: number }): boolean => {
    if (input.busy()) return false;
    const from = o?.from ?? window.scrollY;
    if (o?.from !== undefined) window.scrollTo(0, from);
    const ok = input.goTo(k, from, now(), o?.ms);
    wake();
    return ok;
  };
  /**
   * The focused view's chunk: a failure switches the flow off (plain
   * scrolling) and a later gesture tries again; a down gesture made at the
   * row while it loads pages to Front once it is in.
   */
  const fload = createFocusLoad<FocusRun>({
    load: () =>
      import(
        /* webpackChunkName: "pack-stage-focus" */ './stage-focus-kit'
      ).then((m) => {
        const s = src;
        const ui = host.ui;
        if (!s || !ui) return null;
        return m.createFocusRun({
          src: s,
          state: stage.state,
          wake: stage.wake,
          values: stage.values as Parameters<
            typeof m.createFocusRun
          >[0]['values'],
          ui,
          loop: wake,
          go,
          busy: () => input.busy(),
          stops: () => input.stops(),
          paint: paintRow,
          ended: () => {
            shownSpin = -1;
            shownExit = -1;
            measure();
          },
        });
      }),
    ready: (f, held) => {
      focus = f;
      // a scroll that came before it (a jump) is read again with it
      wake();
      // back from a failure: the flow switches on again (at the row only;
      // further away, the scroll checks again once the page is back near it)
      if (!flowOn()) measure();
      // a gesture kept for the chunk: only where and soon after it was made
      if (
        holdStands(held, now(), where()) &&
        atRow() &&
        f.kindsAt(centre()) !== null
      )
        go(1);
    },
    // a failure, or a load still running at its deadline: plain scrolling
    failed: () => measure(),
    after: (ms, fn) => {
      const id = window.setTimeout(fn, ms);
      return () => window.clearTimeout(id);
    },
  });
  const loadFocus = (): Promise<FocusRun | null> => fload.get(now());
  /** The page rests on the row (where a tap on the centred pack focuses it). */
  const atRow = () => {
    const t = input.table();
    return (
      !!t && !input.busy() && Math.abs(window.scrollY - t.r0) < 1 && flowOn()
    );
  };
  // A plain tap on the centred pack focuses it (the row at rest only).
  const onTap = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const t = e.target as HTMLElement | null;
    const tile = t?.closest?.<HTMLElement>('[data-stage-tile]');
    if (!tile || !flowOn()) return;
    if (focus?.active()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const index = Number(tile.dataset.index);
    if (index !== centre() || !atRow()) return;
    e.preventDefault();
    e.stopPropagation();
    if (tapping) return;
    tapping = true;
    const at = now();
    const id = tile.dataset.packId;
    void loadFocus().then((f) => {
      tapping = false;
      if (f?.active()) return;
      // a slow load: only if the visitor is still at the row, on the same
      // centred pack, and soon after the tap
      if (
        f &&
        (!atRow() ||
          centre() !== index ||
          where().split('|')[1] !== id ||
          now() - at > HOLD_MAX_MS)
      )
        return;
      // not focusable (no data for it): today's pack page
      if (!f || !f.enter(index)) {
        const a = tile.querySelector<HTMLAnchorElement>('a[href]');
        if (a) window.location.assign(a.href);
      }
    });
  };
  let tapping = false;
  const preload = () => void loadFocus();
  // The flow's keys: never while a field, the Top Hits strip
  // or a dialog has focus, never Space on a control, never a key a part of
  // the page already took (the row's own arrows, the sort panel).
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    retry();
    if (!flowOn() || !input.table()) return;
    const intent = flowKeyIntent(e);
    if (!intent) return;
    const t = e.target instanceof Element ? e.target : null;
    if (
      t?.closest(
        'input,textarea,select,[contenteditable],[data-focus-strip],[role="dialog"]',
      ) ||
      document.querySelector('[role="dialog"][aria-modal="true"]')
    )
      return;
    // a link does not take Space (the page scrolls), so it pages here
    if (e.key === ' ' && t?.closest('button,[role="button"],summary,label'))
      return;
    // the lineup's pick: at the lineup only, else the page's own arrows
    if (intent === 'left' || intent === 'right') {
      if (held()) return;
      if (input.key(intent, window.scrollY, now(), e.repeat) === 'free') return;
      e.preventDefault();
      wake();
      return;
    }
    // the leave is under way: every key waits for it
    if (held()) {
      e.preventDefault();
      return;
    }
    // a key at the row before the focused view has loaded: load it
    if (!focus) void loadFocus();
    // one page per press: a held key pages once
    const r = input.key(intent, window.scrollY, now(), e.repeat);
    downHeld();
    if (r === 'free') return;
    e.preventDefault();
    if (r === 'leave') focus?.leave();
    wake();
  };
  // Keyboard users keep the row's controls in the paged part: focus landing
  // in the row's own UI while the page is off the row brings it back there
  // (a focused pack leaves). From the hand-off on the panel is inert, so
  // nothing in it takes focus there.
  const onFocusIn = (e: FocusEvent) => {
    const t = e.target instanceof Element ? e.target : null;
    if (
      !t?.closest(
        '[data-stage-viewport],[data-stage-info],[data-stage-head],[data-stage-nav]',
      )
    )
      return;
    const tb = input.table();
    if (!tb || !flowOn() || window.scrollY > tb.edge || held()) return;
    if (focus?.active()) focus.leave();
    else if (Math.abs(window.scrollY - tb.r0) >= 1) go(0);
  };
  window.addEventListener('keydown', onKey);
  const idleLoad = setTimeout(() => void loadFocus(), 2500);
  const atEntry = () => {
    const st: unknown = window.history.state;
    return (
      /^\/slots\/[^/]+\/?$/.test(window.location.pathname) &&
      !!st &&
      typeof st === 'object' &&
      '__flow' in st
    );
  };
  /** The page's own restoration mode, put back while the flow is off. */
  let restoration: ScrollRestoration | null = null;
  /** Manual restoration while the flow runs (a reload starts at the row); the page's own otherwise. */
  function restore(flowRuns: boolean) {
    if (flowRuns) {
      if (restoration !== null) return;
      restoration = window.history.scrollRestoration;
      window.history.scrollRestoration = 'manual';
    } else if (restoration !== null) {
      window.history.scrollRestoration = restoration;
      restoration = null;
    }
  }
  /**
   * The scroll: wakes the loop; while the flow is off with the focused view
   * in hand (a load that failed or stalled, then landed), the flow switch is
   * checked again, at most once a frame, so it comes back near the row.
   */
  let switchCheck = false;
  function onScroll() {
    // a scroll the flow did not start: the focused view is wanted with it
    if (!focus && flowOn()) void loadFocus();
    if (
      !switchCheck &&
      src &&
      !flowOn() &&
      fload.value() !== null &&
      !rmq.matches &&
      !src.empty
    ) {
      switchCheck = true;
      requestAnimationFrame(() => {
        switchCheck = false;
        if (!flowOn()) measure();
      });
    }
    wake();
  }
  /** The document's load was looked at once (a reload starts at the row). */
  let loadSeen = false;
  const startAtRow = (s: StageSpinSource) => {
    if (loadSeen) return;
    loadSeen = true;
    const nav = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    const y = flowLoadStart(nav?.type, window.scrollY, rowTop(s));
    if (y !== null) window.scrollTo(0, y);
  };
  /** `instant`: the entry's stop is taken with no move (the page's load). */
  const resume = (instant = false) => {
    if (!atEntry() || !flowOn()) return;
    void loadFocus().then((f) => f?.resume(instant));
  };

  const bind = (next: StageSpinSource | null) => {
    if (next === src) return;
    unbindPage?.();
    unbindPage = null;
    if (!next) restore(false);
    if (src) {
      src.flow.removeAttribute('data-flow-on');
      src.flow.removeAttribute('data-flow-return');
      src.flow.removeAttribute('data-flow-last');
      src.flow.removeAttribute('data-flow-wrap');
      clearPast(src);
    }
    src = next;
    if (next) {
      // no restored scroll: a reload or a history load starts at the row
      // (the page's own mode comes back if the flow does not switch on)
      restore(true);
      startAtRow(next);
      const ro = new ResizeObserver(measure);
      ro.observe(next.flow);
      ro.observe(next.panel);
      next.panel.addEventListener('focusin', onFocusIn);
      next.panel.addEventListener('click', onTap, { capture: true });
      // a press loads the focused view ahead of its tap (when idle has not yet)
      next.panel.addEventListener('pointerdown', preload, quiet);
      // the document's load onto a pack's address opens on its stop, placed
      // (under the loader when it shows), not moved to; any later bind (the
      // stage mounted again, Back from the reel) moves there as usual
      const instant = placeInstantly();
      setTimeout(() => resume(instant), 0);
      if (!live) {
        live = document.createElement('p');
        live.className = 'sr-only';
        live.setAttribute('aria-live', 'polite');
        live.setAttribute('aria-atomic', 'true');
        document.body.appendChild(live);
      }
      unbindPage = () => {
        ro.disconnect();
        next.panel.removeEventListener('focusin', onFocusIn);
        next.panel.removeEventListener('click', onTap, { capture: true });
        next.panel.removeEventListener('pointerdown', preload);
      };
      measure();
      restore(flowOn());
    } else input.measure(null, window.scrollY);
    wake();
  };

  // ?debug=1 (the preview): QA reads the driver here.
  const dbg = (window as unknown as { __packStage?: Record<string, unknown> })
    .__packStage;
  if (dbg) {
    trace = [];
    gestures = [];
    dbg.spinTrace = () => ({ trace, gestures });
    dbg.focusKit = () =>
      import(/* webpackChunkName: "pack-stage-focus" */ './stage-focus-kit');
    dbg.focus = () => focus?.debug() ?? null;
    dbg.flow = () => ({
      on: flowOn(),
      bound: src !== null,
      looping,
      table: input.table(),
      stops: input.stops(),
      busy: input.busy(),
      focusFailed: fload.failed(),
      inert,
      lap: stage.state.lap ?? null,
      line: input.lineState(),
    });
  }

  return {
    bind,
    wake,
    stop() {
      clearTimeout(idleLoad);
      if (wrapFade !== null) window.clearTimeout(wrapFade);
      fload.stop();
      focus?.stop();
      window.removeEventListener('keydown', onKey);
      bind(null);
      stopLoop();
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      live?.remove();
      live = null;
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchCancel);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
      rmq.removeEventListener('change', measure);
    },
  };
}
