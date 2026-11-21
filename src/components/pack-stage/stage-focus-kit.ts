/**
 * Pack stage: the focused pack view's lazily loaded chunk.
 * The spin chunk imports it at idle after itself, or at the first tap on a
 * pack; the first load never carries it.
 *
 * - `focusOnFor` builds the focus declaration (`StageFocusOn`) the runtime
 *   and the CSS tiles read from the stage state: the pack's keys for this
 *   size, the focus term and the spotlight.
 * - `createFocusRun` is the focused view itself: the declaration, the stop
 *   blocks, the address and the leave. It owns no input, no keys and no
 *   pager: the spin chunk's flow pager moves the page, and each frame hands
 *   it the focus value read from the scroll (a tap or a down gesture at the
 *   row pages to Front; paging back past Front, "All packs", Escape, Home or
 *   browser Back pages from Front to the row, which ends the focus).
 * - The address follows `stage-focus-address`: a tap
 *   pushes `/slots/<id>`, a scroll replaces it, and leaving the details
 *   downwards or ending the focus puts the base path back without a new
 *   entry.
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
import { BACK_PRINT_REST_MS, focusBackWanted } from './stage-flow';
import { spotAt } from './stage-focus';
import {
  focusKeys,
  focusPlate,
  focusStops,
  type FocusVariant,
} from './stage-focus-keys';
import {
  SLOT_PATH,
  createFocusAddress,
  type FocusEntryKind,
} from './stage-focus-address';
import { readFocusSeeds } from './stage-focus-seeds';
import { STAGE_DESKTOP_QUERY } from './stage-gate';
import { frame } from './stage-motion';
import { entryPlaced, pendingEntry } from './stage-entry-cover';

export { FOCUS_DURATIONS, FOCUS_WINDOW } from './stage-focus-keys';
export { blockAt, power1InOut } from './stage-focus';
export { focusStops };

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
  /** The paged stops: the row, the pack's rests, then the lineup rest. */
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
  /** The page has left the details downwards (the address shows the base path). */
  past?: boolean;
  /** The hand-off from Closing to the lineup: 0 at Closing and above, 1 at the lineup. */
  handoff?: number;
};

/** How a focus begins. */
export type FocusEnter = {
  /** A tap pushes the address; a scroll or key replaces it (default: tap). */
  how?: Exclude<FocusEntryKind, 'resume'>;
  /** Resume this focus entry of ours (Back from the pack page, Forward). */
  entry?: string;
  /** Page to its first stop (false: the flow is already paging). */
  page?: boolean;
  /** Place the page on that stop at once, with no move (a document load). */
  instant?: boolean;
};

export type FocusRun = {
  active(): boolean;
  /** The leave is under way (input is swallowed until it ends). */
  leaving(): boolean;
  /** The stop kinds the pack at `index` would have; null: not focusable. */
  kindsAt(index: number): FocusStopKind[] | null;
  /** The focused pack's stop kinds. */
  kinds(): readonly FocusStopKind[];
  /** Focus the pack at `index` of the shown row; false: not focusable here. */
  enter(index: number, o?: FocusEnter): boolean;
  /**
   * The pick in the lineup: the focus is rebuilt, unseen, for the pack at
   * `index` (keys, stops, variant, back, blocks, address); false: it cannot be.
   */
  pick(index: number): boolean;
  /** "All packs" (and Escape, Home, browser Back); nothing past the details. */
  leave(fromHistory?: boolean): void;
  /**
   * The lap ends (the wrap, or Home and Escape at the lineup): the focus ends
   * where it is, with no move and no history step (past the details the
   * address already shows the base path).
   */
  release(): void;
  /** One frame; true when at rest. */
  frame(now: number, f: FocusFrame): boolean;
  /**
   * The page shows a focus entry of ours (Back from the reel, Forward): focus
   * that pack. `instant`: the page is placed on the entry's stop with no move.
   */
  resume(instant?: boolean): boolean;
  /** Debug: the stops and timing of the last moves. */
  debug(): unknown;
  stop(): void;
};

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
  const addr = createFocusAddress(
    window.history,
    () => window.location,
    (ms, fn) => {
      const id = window.setTimeout(fn, ms);
      return () => window.clearTimeout(id);
    },
  );
  /** The page has left the details downwards (last frame). */
  let past = false;
  let desktop = false;
  const subs = new Set<(f: number) => void>();
  let lastF = -1;
  const offs: (() => void)[] = [];
  /** ?debug=1 only: [time, scrollY, focus] per frame, and move starts. */
  const trace: number[][] | null = (
    window as unknown as { __packStage?: unknown }
  ).__packStage
    ? []
    : null;
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
  /** Since when the pack has rested at a stop with its back not yet let through (null: not resting). */
  let restingSince: number | null = null;
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
    // the address goes back with the pack (our pushed entry: one step back)
    addr.end();
    past = false;
    seed = null;
    d.ended();
    // browser Forward during the leave brought the pack's entry back: the
    // page follows the address and resumes it (as Forward does at the row)
    if (addr.strayed()) window.setTimeout(() => resumeEntry(), 0);
  };

  const onPop = () => {
    // our own step (the address leaving with the pack, or back onto it)
    if (addr.popped()) {
      if (!on && addr.strayed()) resumeEntry();
      return;
    }
    if (on) {
      // past the details the address is the base path: Back leaves the
      // page, and Forward to the pack's entry is stepped back again, so the
      // address keeps matching what the page shows
      if (past) {
        if (addr.onPack()) addr.show(false);
        return;
      }
      if (!addr.onPack()) run.leave(true);
      return;
    }
    // Forward to a focus entry of ours: focus that pack again (no new entry)
    resumeEntry();
  };
  const resumeEntry = (instant = false): boolean => {
    const mark = addr.resumable();
    const m = SLOT_PATH.exec(window.location.pathname);
    if (on || mark === null || !m?.[1]) return false;
    const id = decodeURIComponent(m[1]);
    const tile = d.src.panel.querySelector<HTMLElement>(
      `[data-stage-panel]:not([hidden]) [data-stage-tile][data-pack-id="${CSS.escape(id)}"]`,
    );
    return tile
      ? run.enter(Number(tile.dataset.index), { entry: mark, instant })
      : false;
  };
  let savedK = 0;
  /** A document load onto the pack's address: the loader waits for the rest. */
  let entryCover = false;
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
    focusStops(focusVariant({ capsule: s.shape === 'capsule', back: s.back }));
  /**
   * The declaration for the pack at `index`: its keys, stops, variant and
   * back, and the docked pack's edges for the blocks beside it. `anchorY`:
   * the art centre in the panel at the row's rest.
   */
  const declare = (
    index: number,
    p: NonNullable<ReturnType<typeof packAt>>,
    anchorY: number,
  ) => {
    const { id, s } = p;
    const panel = d.src.panel;
    seed = s;
    desktop = window.matchMedia(STAGE_DESKTOP_QUERY).matches;
    kinds = kindsOf(s);
    const host = panel.querySelector<HTMLElement>('[data-stage-canvas]');
    const w = host?.clientWidth ?? panel.clientWidth;
    const h = host?.clientHeight ?? panel.clientHeight;
    decl = focusOnFor({
      id,
      slug: id,
      index,
      desktop,
      capsule: s.shape === 'capsule',
      back: s.back,
      panel: { w, h },
      anchorY,
    });
    d.src.wrap.style.setProperty('--focus-n', String(kinds.length));
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
  };

  const run: FocusRun = {
    active: () => on,
    leaving: () => leaving,
    kindsAt(index) {
      const p = packAt(index);
      return p ? kindsOf(p.s) : null;
    },
    kinds: () => kinds,
    enter(index, o = {}) {
      if (on) return false;
      const fromEntry = o.entry;
      const page = o.page ?? true;
      const p = packAt(index);
      if (!p) return false;
      const { tile, id } = p;
      const host = d.src.panel.querySelector<HTMLElement>(
        '[data-stage-canvas]',
      );
      const h = host?.clientHeight ?? d.src.panel.clientHeight;
      const art = tile.querySelector<HTMLElement>('[data-stage-art]');
      const hr = (host ?? d.src.panel).getBoundingClientRect();
      const ar = art?.getBoundingClientRect();
      const anchorY =
        ar && h > 0 ? (ar.top + ar.height / 2 - hr.top) / h : 0.45;
      declare(index, p, anchorY);
      d.src.wrap.setAttribute('data-focus-on', '');
      on = true;
      leftRow = false;
      leaving = false;
      settled = false;
      publish();
      // the address: /slots/<id> (a tap pushes it, a scroll replaces it)
      past = false;
      addr.enter(
        id,
        fromEntry ? 'resume' : (o.how ?? 'tap'),
        fromEntry ?? `${id}:${Math.round(now())}`,
      );
      // the row's motion values repaint the tiles; the focus repaints after
      for (const v of Object.values(d.values))
        offs.push(v.on('change', () => frame.render(d.paint)));
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
      // a document load: there within a frame, under the loader's cover,
      // which lets go once the pack rests on that stop
      entryCover = pendingEntry() !== null;
      if (page) d.go(at, o.instant ? { ms: 1 } : undefined);
      trace?.push([now(), -1, 1]);
      d.loop();
      return true;
    },
    pick(index) {
      if (!on || leaving || !decl) return false;
      if (index === decl.ctx.index) return true;
      const p = packAt(index);
      if (!p) return false;
      // the art centre is the row's, the same for every pack (the tiles are
      // posed in the lineup now, so it is not measured again)
      declare(index, p, decl.ctx.anchorY);
      // the back waits for the pack to rest at a stop, as at a tap
      settled = false;
      publish();
      addr.pack(p.id);
      render(true);
      d.loop();
      return true;
    },
    leave(fromHistory = false) {
      // past the details there is no move home from here (the flow pages)
      if (!on || leaving || past) return;
      if (fromHistory) addr.forget(); // the address already moved
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
      // the active block has faded: from a later stop, jump to Front first.
      // A move that began meanwhile (a snap back to the stop) is let land
      // first, as the mid-move path does, or the leave would never start.
      const home = () => {
        if (!on) return;
        if (
          !d.go(0, k > 1 ? { from: d.stops()[1] ?? 0 } : undefined) &&
          d.busy()
        )
          setTimeout(home, 50);
        d.loop();
      };
      setTimeout(home, LEAVE_FADE_MS);
    },
    release() {
      if (on) end();
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
      // the address: the pack's while in the details, the base path past them
      past = !!f.past;
      if (!leaving) addr.show(!past);
      if (trace && trace.push([t, window.scrollY, f.focus]) > 4000)
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
      // past Closing + 0.5 the back is let go (the lineup's fronts take its
      // room); back at a stop it is printed again once the pack rests there,
      // never mid-move
      const handoff = f.handoff ?? 0;
      if (settled && !focusBackWanted(handoff)) {
        settled = false;
        publish();
      }
      const resting = f.idle && f.focus >= 1 - 1e-3 && !(handoff > 0);
      restingSince = resting && !settled ? (restingSince ?? t) : null;
      if (restingSince !== null && t - restingSince >= BACK_PRINT_REST_MS) {
        settled = true;
        restingSince = null;
        publish();
      }
      if (entryCover && f.idle && f.focus >= 1 - 1e-3) {
        entryCover = false;
        entryPlaced();
      }
      // the stop this entry rests on, for Back and Forward
      const k = f.target;
      const entry = addr.entry();
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
      // awake while the back waits out its rest
      return f.idle && !leaving && restingSince === null;
    },
    resume: (instant) => resumeEntry(instant),
    debug: () => ({
      on,
      kinds,
      stops: d.stops(),
      focus: lastF,
      busy: d.busy(),
      past,
      entry: addr.entry(),
      onPack: addr.onPack(),
      trace,
    }),
    stop() {
      window.removeEventListener('popstate', onPop);
      if (on) end();
    },
  };
  return run;
}
