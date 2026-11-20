/**
 * Pack stage: the focused pack view's lazily loaded chunk (plan-focus-ciao).
 * The spin chunk imports it at idle after itself, or at the first tap on a
 * pack; the first load never carries it.
 *
 * - `focusOnFor` builds the focus declaration (`StageFocusOn`) the runtime
 *   and the CSS tiles read from the stage state: the pack's keys for this
 *   size, the focus term and the spotlight.
 * - `createFocusRun` is the focused view itself. The spin chunk's one set of
 *   listeners hands it the wheel, touch and keys while a pack is focused
 *   (the hand-off: a tap on the centred pack pages from the row to Front;
 *   paging back past Front, "All packs", Escape or browser Back pages from
 *   Front to the row, which ends the focus and gives the input back).
 */
import { createElement, type ReactNode } from 'react';
import {
  FocusStops,
  type FocusStopKind,
} from '@/components/pack-flow/FocusStops';
import type { FlowSeed } from '@/components/pack-flow/types';
import type {
  FocusCtx,
  PackBackDetails,
  StageFocusOn,
  StageSpinSource,
  StageState,
} from './contract';
import { FOCUS_TERM } from './stage-compose';
import { spotAt } from './stage-focus';
import {
  focusKeys,
  focusPlate,
  focusStops,
  type FocusVariant,
} from './stage-focus-keys';
import { readFocusSeeds } from './stage-focus-seeds';
import { STAGE_DESKTOP_QUERY } from './stage-gate';
import { createPager, durationFor } from './stage-pager';

export { FOCUS_DURATIONS, FOCUS_WINDOW } from './stage-focus-keys';
export { blockAt, power1InOut } from './stage-focus';
export { focusStops };

/** Each stop is this many panels of scroll (Ciao's section). */
export const STOP_PANELS = 1.25;
/** The active block fades this long before "All packs" returns to the row. */
export const LEAVE_FADE_MS = 250;

/** A pack's stop list: a capsule, a pack with no pull odds, or a card pack. */
export function focusVariant(o: {
  capsule: boolean;
  back: PackBackDetails | null;
}): FocusVariant {
  if (o.capsule) return 'capsule';
  return o.back?.odds && o.back.odds.length > 0 ? 'sleeve' : 'noOdds';
}

/**
 * The declaration for pack `id` at `index` of the attached row. `slug` picks
 * its poses (a pack not in the table borrows 151's); `back` is printed only
 * for a card pack with pull odds.
 */
export function focusOnFor(o: {
  id: string;
  slug: string;
  index: number;
  desktop: boolean;
  capsule: boolean;
  back: PackBackDetails | null;
  panel: { w: number; h: number };
  anchorY: number;
}): StageFocusOn {
  const variant = focusVariant(o);
  const ctx: FocusCtx = {
    index: o.index,
    anchorY: o.anchorY,
    keys: focusKeys(o.slug, o.desktop, variant),
    panel: o.panel,
  };
  return {
    id: o.id,
    ctx,
    term: FOCUS_TERM,
    spot: spotAt,
    details: variant === 'sleeve' ? o.back : null,
  };
}

type Obs = {
  get(): number;
  on(e: 'change', fn: (v: number) => void): () => void;
};

export type FocusRunDeps = {
  src: StageSpinSource;
  /** The stage engine's state and wake (identity-stable). */
  state: StageState;
  wake(): void;
  /** Motion values the row repaints on; the focus repaints after them. */
  values: Record<string, Obs>;
  /** Renders the stop blocks over the panel (null: none). */
  ui(node: ReactNode): void;
  /** Wakes the spin chunk's frame loop. */
  loop(): void;
  /** The site header's height (the panel sticks under it). */
  top(): number;
  /** Repaints the row's CSS tiles from the state (focus included). */
  paint(): void;
  /** The focus ended: the spin chunk takes the input back. */
  ended(): void;
};

export type FocusRun = {
  active(): boolean;
  /** Focus the pack at `index` of the shown row; false: not focusable here. */
  enter(index: number, fromEntry?: string): boolean;
  /** "All packs" (and Escape, browser Back). */
  leave(fromHistory?: boolean): void;
  wheel(e: WheelEvent): void;
  touchStart(e: TouchEvent): void;
  touchMove(e: TouchEvent): void;
  touchEnd(): void;
  key(e: KeyboardEvent): void;
  /** One frame; true when at rest. */
  frame(now: number): boolean;
  /** The page shows a focus entry of ours (Back from the reel, Forward): focus that pack. */
  resume(): boolean;
  /** Debug: the stops and timing of the last moves. */
  debug(): unknown;
  stop(): void;
};

const MARK = '__flow';
/** The stop a focus entry rests on (restored on Forward and Back). */
const stopKey = (entry: string) => `pack-flow:stop:${entry}`;
/** A page left off a stop (scrollbar, a pinch) snaps back after this quiet. */
const SNAP_QUIET_MS = 150;
const SNAP_MS = 600;
/** ?debug=1: QA scrubbing a move by scroll holds the snap-back. */
const snapHeld = () =>
  !!(window as unknown as { __packStage?: { holdSnap?: boolean } }).__packStage
    ?.holdSnap;

export function createFocusRun(d: FocusRunDeps): FocusRun {
  const pager = createPager();
  const seeds = readFocusSeeds<FlowSeed>();
  let on = false;
  let leftRow = false;
  let leaving = false;
  let kinds: FocusStopKind[] = [];
  let stops: number[] = [];
  let decl: StageFocusOn | null = null;
  let seed: FlowSeed | null = null;
  let entry: string | null = null;
  let path = '';
  let base = '';
  let desktop = false;
  const subs = new Set<(f: number) => void>();
  let lastF = -1;
  const offs: (() => void)[] = [];
  /** ?debug=1: [time, scrollY, focus] per frame, and move starts. */
  const trace: number[][] = [];
  const now = () => performance.now();

  const render = () => {
    if (!seed) return;
    d.ui(
      createElement(FocusStops, {
        key: seed.pack.id,
        seed,
        kinds,
        mode: 'stage',
        desktop,
        leaving,
        subscribe: (fn: (f: number) => void) => {
          subs.add(fn);
          fn(Math.max(0, lastF));
          return () => {
            subs.delete(fn);
          };
        },
        go: (k: number) => {
          if (pager.goTo(k, window.scrollY, now())) d.loop();
        },
        leave: () => run.leave(),
        onBack: (back: PackBackDetails | null) => {
          if (!decl || decl.details === back) return;
          if (decl.details === null && back === null) return;
          // a pack that gains or loses its odds keeps its stop list until
          // the next focus; the print follows the text
          if (kinds.includes('odds') && back) {
            decl = { ...decl, details: back };
            d.state.focusOn = decl;
            d.wake();
          }
        },
      }),
    );
  };

  const measureStops = () => {
    const panel = d.src.panel;
    const P = panel.offsetHeight;
    const top = d.top();
    const wrapTop = d.src.wrap.getBoundingClientRect().top + window.scrollY;
    const s0 = Math.max(0, Math.round(wrapTop - top));
    stops = [s0];
    for (let k = 1; k <= kinds.length; k++)
      stops.push(Math.round(s0 + k * STOP_PANELS * P));
    pager.setStops(stops);
  };

  const end = () => {
    on = false;
    leftRow = false;
    leaving = false;
    for (const off of offs.splice(0)) off();
    d.src.wrap.removeAttribute('data-focus-on');
    d.src.wrap.style.removeProperty('--focus-n');
    d.src.panel.style.removeProperty('--dock-bottom');
    d.src.panel.style.removeProperty('--dock-left');
    d.state.focus = 0;
    d.state.focusOn = null;
    decl = null;
    d.wake();
    d.ui(null);
    pager.setStops(null);
    subs.clear();
    lastF = -1;
    d.paint();
    // the address goes back with the pack (our entry: one step back)
    if (entry && window.location.pathname === path) {
      if (window.history.state?.[MARK] === entry) {
        ignorePop = true; // the popstate this step fires
        window.history.back();
      } else window.history.replaceState(null, '', base);
    }
    entry = null;
    seed = null;
    d.ended();
  };

  let ignorePop = false;
  const onPop = () => {
    if (ignorePop) {
      ignorePop = false;
      return;
    }
    if (on && window.location.pathname !== path) {
      run.leave(true);
      return;
    }
    // Forward to a focus entry of ours: focus that pack again (no new entry)
    resumeEntry();
  };
  const resumeEntry = (): boolean => {
    const st: unknown = window.history.state;
    const mark =
      st && typeof st === 'object'
        ? (st as Record<string, unknown>)[MARK]
        : null;
    const m = /^\/slots\/([^/]+)\/?$/.exec(window.location.pathname);
    if (on || typeof mark !== 'string' || !m?.[1]) return false;
    const id = decodeURIComponent(m[1]);
    const tile = d.src.panel.querySelector<HTMLElement>(
      `[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id="${CSS.escape(id)}"]`,
    );
    return tile ? run.enter(Number(tile.dataset.index), mark) : false;
  };
  let lastScrollAt = 0;
  let savedK = 0;
  const onScroll = () => {
    lastScrollAt = performance.now();
  };
  window.addEventListener('popstate', onPop);

  const run: FocusRun = {
    active: () => on,
    enter(index, fromEntry) {
      if (on) return false;
      const panel = d.src.panel;
      const tile = panel.querySelector<HTMLElement>(
        `[data-stage-panel]:not([hidden]) [data-stage-tile][data-index="${index}"]`,
      );
      const id = tile?.dataset.packId;
      const s = id ? seeds[id] : undefined;
      if (!tile || !id || !s) return false;
      seed = s;
      desktop = window.matchMedia(STAGE_DESKTOP_QUERY).matches;
      const capsule = s.shape === 'capsule';
      const variant = focusVariant({ capsule, back: s.back });
      kinds = focusStops(variant) as FocusStopKind[];
      const host = panel.querySelector<HTMLElement>('[data-stage-canvas]');
      const w = host?.clientWidth ?? panel.clientWidth;
      const h = host?.clientHeight ?? panel.clientHeight;
      const art = tile.querySelector<HTMLElement>('[data-stage-art]');
      const hr = (host ?? panel).getBoundingClientRect();
      const ar = art?.getBoundingClientRect();
      const anchorY =
        ar && h > 0 ? (ar.top + ar.height / 2 - hr.top) / h : 0.45;
      decl = focusOnFor({
        id,
        slug: id,
        index,
        desktop,
        capsule,
        back: s.back,
        panel: { w, h },
        anchorY,
      });
      d.src.wrap.style.setProperty('--focus-n', String(kinds.length));
      // the docked pack's edges (Top Hits, Recent Pulls) for the blocks beside it
      const dock = decl.ctx.keys.find((k) => k.kind === 'pulls');
      const plate = focusPlate(id) ?? focusPlate('151');
      if (dock && plate) {
        const L = dock.long * h;
        const W = (L * plate[0]) / plate[1];
        panel.style.setProperty(
          '--dock-bottom',
          `${Math.round(dock.cy * h + L / 2)}px`,
        );
        panel.style.setProperty(
          '--dock-left',
          `${Math.round(dock.cx * w - W / 2)}px`,
        );
      }
      d.src.wrap.setAttribute('data-focus-on', '');
      measureStops();
      pager.setDuration(durationFor(kinds));
      on = true;
      leftRow = false;
      leaving = false;
      d.state.focusOn = decl;
      // the address: /slots/<id>, Back unfocuses (plan section 7)
      base = window.location.pathname + window.location.search;
      path = `/slots/${encodeURIComponent(id)}`;
      if (fromEntry) entry = fromEntry;
      else {
        entry = `${id}:${Math.round(now())}`;
        window.history.pushState({ [MARK]: entry }, '', path);
      }
      // the row's motion values repaint the tiles; the focus repaints after
      for (const v of Object.values(d.values))
        offs.push(v.on('change', () => requestAnimationFrame(d.paint)));
      const ro = new ResizeObserver(() => {
        if (on && !pager.busy()) {
          const k = Math.round(pager.focusAt(window.scrollY));
          measureStops();
          window.scrollTo(0, stops[k] ?? stops[0] ?? 0);
        }
      });
      ro.observe(panel);
      offs.push(() => ro.disconnect());
      window.addEventListener('scroll', onScroll, { passive: true });
      offs.push(() => window.removeEventListener('scroll', onScroll));
      render();
      // Forward or Back to an entry: the stop it rested on
      let at = 1;
      if (fromEntry)
        try {
          const v = Number(window.sessionStorage.getItem(stopKey(fromEntry)));
          if (v >= 1 && v <= kinds.length) at = Math.round(v);
        } catch {
          // storage blocked: Front
        }
      savedK = at;
      pager.goTo(at, window.scrollY, now());
      trace.push([now(), -1, 1]);
      d.loop();
      return true;
    },
    leave(fromHistory = false) {
      if (!on || leaving) return;
      if (fromHistory) entry = null; // the address already moved
      const k = Math.round(pager.focusAt(window.scrollY));
      if (pager.busy() || k <= 1) {
        // from Front (or mid-move): straight back to the row
        if (!pager.busy()) pager.goTo(0, window.scrollY, now());
        else
          setTimeout(() => {
            if (on) run.leave(fromHistory);
          }, 50);
        d.loop();
        return;
      }
      leaving = true;
      render();
      setTimeout(() => {
        if (!on) return;
        // unseen: the active block has faded; jump to Front, then return
        window.scrollTo(0, stops[1] ?? 0);
        leaving = false;
        render();
        pager.goTo(0, stops[1] ?? 0, now());
        d.loop();
      }, LEAVE_FADE_MS);
    },
    wheel(e) {
      if (leaving) {
        e.preventDefault();
        return;
      }
      const dy =
        e.deltaMode === 1
          ? e.deltaY * 16
          : e.deltaMode === 2
            ? e.deltaY * window.innerHeight
            : e.deltaY;
      if (pager.wheel(dy, e.deltaX, e.shiftKey, window.scrollY, now())) {
        e.preventDefault();
        if (pager.busy()) trace.push([now(), -2, dy]);
      }
      d.loop();
    },
    touchStart(e) {
      const p = e.touches[0];
      if (!p || e.touches.length > 1) return;
      pager.touchStart(p.clientX, p.clientY, now());
    },
    touchMove(e) {
      const p = e.touches[0];
      if (!p || e.touches.length > 1) return;
      if (pager.touchMove(p.clientX, p.clientY) && e.cancelable)
        e.preventDefault();
    },
    touchEnd() {
      if (leaving) return;
      pager.touchEnd(window.scrollY, now());
      d.loop();
    },
    key(e) {
      if (leaving) return;
      const t = e.target as HTMLElement | null;
      if (
        t?.closest?.(
          'input,textarea,select,[contenteditable],[data-focus-strip],[role="dialog"]',
        )
      )
        return;
      if (e.key === 'Escape') {
        if (document.querySelector('[role="dialog"][aria-modal="true"]'))
          return;
        run.leave();
        return;
      }
      const k = Math.round(pager.focusAt(window.scrollY));
      const n = kinds.length;
      let to: number | null = null;
      if (e.key === 'ArrowDown' || e.key === 'PageDown') to = k + 1;
      else if (e.key === 'ArrowUp' || e.key === 'PageUp') to = k - 1;
      else if (
        e.key === ' ' &&
        !t?.closest?.('button,a[href],[role="button"],summary,label')
      )
        to = e.shiftKey ? k - 1 : k + 1;
      else if (e.key === 'Home') to = 1;
      else if (e.key === 'End') to = n;
      if (to === null) return;
      e.preventDefault();
      if (to < 1) {
        run.leave();
        return;
      }
      if (pager.goTo(Math.min(n, to), window.scrollY, now())) d.loop();
    },
    frame(t) {
      if (!on) return true;
      const f = pager.frame(window.scrollY, t);
      if (f.scrollTo !== null && Math.abs(f.scrollTo - window.scrollY) >= 0.5)
        window.scrollTo(0, f.scrollTo);
      if (f.focus > 0.001) leftRow = true;
      if (trace.push([t, window.scrollY, f.focus]) > 4000)
        trace.splice(0, 2000);
      if (f.focus !== lastF) {
        lastF = f.focus;
        d.state.focus = Math.max(1e-6, f.focus);
        d.wake();
        d.paint();
        for (const fn of subs) fn(f.focus);
      }
      if (leftRow && !f.animating && f.target === 0 && f.focus <= 0) {
        end();
        return true;
      }
      if (f.idle && !leaving && stops.length > 0) {
        const k = Math.round(pager.focusAt(window.scrollY));
        const off = Math.abs(window.scrollY - (stops[k] ?? window.scrollY));
        if (off > 0.5) {
          // native scroll moved the page (scrollbar, a pinch): back on a stop
          if (t - lastScrollAt > SNAP_QUIET_MS && !snapHeld())
            pager.goTo(k, window.scrollY, t, SNAP_MS);
          return false;
        }
        if (k >= 1 && k !== savedK && entry) {
          savedK = k;
          try {
            window.sessionStorage.setItem(stopKey(entry), String(k));
          } catch {
            // storage blocked: Forward opens on Front
          }
        }
      }
      return f.idle && !leaving;
    },
    resume: () => resumeEntry(),
    debug: () => ({
      on,
      kinds,
      stops,
      focus: lastF,
      busy: pager.busy(),
      trace,
    }),
    stop() {
      window.removeEventListener('popstate', onPop);
      if (on) end();
    },
  };
  return run;
}
