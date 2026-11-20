/**
 * Pack stage: the focused pack view's lazily loaded chunk (plan-focus-ciao).
 * The spin chunk imports it at idle after itself, or at the first tap on a
 * pack; the first load never carries it.
 *
 * - `focusOnFor` builds the focus declaration (`StageFocusOn`) the runtime
 *   and the CSS tiles read from the stage state: the pack's keys for this
 *   size, the focus term and the spotlight.
 * - `createFocusRun` is the focused view itself: the declaration, the stop
 *   blocks, the address and the leave. It owns no input and no pager: the
 *   spin chunk's flow pager moves the page, and each frame hands it the
 *   focus value read from the scroll (a tap or a down gesture at the row
 *   pages to Front; paging back past Front, "All packs", Escape or browser
 *   Back pages from Front to the row, which ends the focus).
 */
import { createElement, startTransition, type ReactNode } from 'react';
import {
  FocusStops,
  type FocusStopKind,
} from '@/components/pack-flow/FocusStops';
import type { FlowSeed } from '@/components/pack-flow/types';
import { loadSchemas } from '@/lib/lazy-schemas';
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
  /**
   * Pages to stop k (0: the row); `from`: jump there first. False: a move
   * is playing, or the page is already there.
   */
  go(k: number, o?: { from?: number; ms?: number }): boolean;
  /** A move is playing. */
  busy(): boolean;
  /** The paged stops: the row, then the pack's rests. */
  stops(): readonly number[];
  /** Repaints the row's CSS tiles from the state (focus included). */
  paint(): void;
  /** The focus ended: the spin chunk takes the input back. */
  ended(): void;
};

/** What the flow hands the focused view each frame. */
export type FocusFrame = {
  /** The focus value F (0 the row, k a stop), read from the scroll. */
  focus: number;
  /** The stop a move heads to or rests on (null: none, the free part). */
  target: number | null;
  animating: boolean;
  idle: boolean;
};

export type FocusRun = {
  active(): boolean;
  /** The leave is under way (input is swallowed until it ends). */
  leaving(): boolean;
  /** The stop kinds the pack at `index` would have; null: not focusable. */
  kindsAt(index: number): FocusStopKind[] | null;
  /** The focused pack's stop kinds. */
  kinds(): readonly FocusStopKind[];
  /**
   * Focus the pack at `index` of the shown row; false: not focusable here.
   * `page`: page to its first stop (false: the flow is already paging).
   */
  enter(index: number, fromEntry?: string, page?: boolean): boolean;
  /** "All packs" (and Escape, browser Back). */
  leave(fromHistory?: boolean): void;
  key(e: KeyboardEvent): void;
  /** One frame; true when at rest. */
  frame(now: number, f: FocusFrame): boolean;
  /** The page shows a focus entry of ours (Back from the reel, Forward): focus that pack. */
  resume(): boolean;
  /** Debug: the stops and timing of the last moves. */
  debug(): unknown;
  stop(): void;
};

const MARK = '__flow';
/** The stop a focus entry rests on (restored on Forward and Back). */
const stopKey = (entry: string) => `pack-flow:stop:${entry}`;

export function createFocusRun(d: FocusRunDeps): FocusRun {
  const seeds = readFocusSeeds<FlowSeed>();
  // The focused pack's live data is validated with the lazy schemas: load and
  // evaluate them at idle now, so that chunk never runs inside a tap's zoom.
  const whenIdle =
    typeof window.requestIdleCallback === 'function'
      ? (fn: () => void) => window.requestIdleCallback(fn, { timeout: 4000 })
      : (fn: () => void) => window.setTimeout(fn, 200);
  whenIdle(() => void loadSchemas().catch(() => {}));
  let on = false;
  let leftRow = false;
  let leaving = false;
  let kinds: FocusStopKind[] = [];
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

  /** `mount`: the first render of a focus, as a transition (below). */
  const render = (mount = false) => {
    if (!seed) return;
    const node = createElement(FocusStops, {
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
        if (d.go(k)) d.loop();
      },
      leave: () => run.leave(),
      onBack: (back: PackBackDetails | null) => {
        if (!decl || decl.details === back) return;
        if (decl.details === null && back === null) return;
        // a pack that gains or loses its odds keeps its stop list until
        // the next focus; the print follows the text
        if (kinds.includes('odds') && back) {
          decl = { ...decl, details: back };
          publish();
        }
      },
    });
    // the mount is a transition: React renders the blocks in slices, never
    // one long frame of the zoom; later renders (leaving) are urgent
    if (mount) startTransition(() => d.ui(node));
    else d.ui(node);
  };

  /**
   * The declaration the runtime reads. The back is held back (details null)
   * until the pack has first settled at a stop: printing it (a canvas print
   * and an upload) must never land inside the tap's zoom.
   */
  let settled = false;
  const publish = () => {
    if (!decl) return;
    d.state.focusOn =
      settled || decl.details === null ? decl : { ...decl, details: null };
    d.wake();
  };

  const end = () => {
    on = false;
    leftRow = false;
    leaving = false;
    for (const off of offs.splice(0)) off();
    d.src.wrap.removeAttribute('data-focus-on');
    // the row's own UI fades back in (not at once) for this while
    const wrap = d.src.wrap;
    wrap.setAttribute('data-focus-off', '');
    window.setTimeout(() => wrap.removeAttribute('data-focus-off'), 600);
    d.src.wrap.style.removeProperty('--focus-n');
    d.src.panel.style.removeProperty('--dock-bottom');
    d.src.panel.style.removeProperty('--dock-left');
    d.state.focus = 0;
    d.state.focusOn = null;
    decl = null;
    d.wake();
    d.ui(null);
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
  let savedK = 0;
  window.addEventListener('popstate', onPop);
  /** The pack at `index` of the shown row, with its seed (null: not focusable). */
  const packAt = (index: number) => {
    const tile = d.src.panel.querySelector<HTMLElement>(
      `[data-stage-panel]:not([hidden]) [data-stage-tile][data-index="${index}"]`,
    );
    const id = tile?.dataset.packId;
    const s = id ? seeds[id] : undefined;
    return tile && id && s ? { tile, id, s } : null;
  };
  const kindsOf = (s: FlowSeed): FocusStopKind[] =>
    focusStops(
      focusVariant({ capsule: s.shape === 'capsule', back: s.back }),
    ) as FocusStopKind[];

  const run: FocusRun = {
    active: () => on,
    leaving: () => leaving,
    kindsAt(index) {
      const p = packAt(index);
      return p ? kindsOf(p.s) : null;
    },
    kinds: () => kinds,
    enter(index, fromEntry, page = true) {
      if (on) return false;
      const panel = d.src.panel;
      const p = packAt(index);
      if (!p) return false;
      const { tile, id, s } = p;
      seed = s;
      desktop = window.matchMedia(STAGE_DESKTOP_QUERY).matches;
      const capsule = s.shape === 'capsule';
      kinds = kindsOf(s);
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
      on = true;
      leftRow = false;
      leaving = false;
      settled = false;
      publish();
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
      render(true);
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
      if (page) d.go(at);
      trace.push([now(), -1, 1]);
      d.loop();
      return true;
    },
    leave(fromHistory = false) {
      if (!on || leaving) return;
      if (fromHistory) entry = null; // the address already moved
      if (d.busy()) {
        // mid-move: leave once it lands
        setTimeout(() => {
          if (on) run.leave(fromHistory);
        }, 50);
        d.loop();
        return;
      }
      const k = Math.round(Math.max(0, lastF));
      // The text goes first, from any stop; `leaving` holds every block hidden
      // until the focus ends, so no block (Front's included) shows on the way.
      leaving = true;
      render();
      // From a later stop the pack goes home from where it is: Front's pose
      // becomes this stop's, so the jump to Front below moves nothing and the
      // last move runs from this pose straight to the row.
      // `leaving`: the neighbours come back over the leave's last part only.
      const held = k > 1 ? decl?.ctx.keys[k - 1] : undefined;
      if (decl) {
        const keys = held ? [held, ...decl.ctx.keys.slice(1)] : decl.ctx.keys;
        decl = { ...decl, ctx: { ...decl.ctx, keys, leaving: true } };
        publish();
      }
      setTimeout(() => {
        if (!on) return;
        // the active block has faded: from a later stop, jump to Front first
        d.go(0, k > 1 ? { from: d.stops()[1] ?? 0 } : undefined);
        d.loop();
      }, LEAVE_FADE_MS);
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
      const k = Math.round(Math.max(0, lastF));
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
      if (d.go(Math.min(n, to))) d.loop();
    },
    frame(t, f) {
      if (!on) return true;
      if (f.focus > 0.001) leftRow = true;
      // paged back past Front by a gesture: a leave too (text out, the
      // neighbours back over its last part)
      if (f.animating && f.target === 0 && !leaving && leftRow && decl) {
        leaving = true;
        render();
        decl = { ...decl, ctx: { ...decl.ctx, leaving: true } };
        publish();
      }
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
      if (f.idle && !settled && f.focus >= 1 - 1e-3) {
        settled = true;
        publish();
      }
      // the stop this entry rests on, for Back and Forward
      const k = f.target;
      if (f.idle && !leaving && entry && k !== null && k >= 1) {
        if (k !== savedK && k <= kinds.length) {
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
      stops: d.stops(),
      focus: lastF,
      busy: d.busy(),
      trace,
    }),
    stop() {
      window.removeEventListener('popstate', onPop);
      if (on) end();
    },
  };
  return run;
}
