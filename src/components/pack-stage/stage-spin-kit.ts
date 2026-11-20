/**
 * Pack stage, step 2: the scroll spin's lazily loaded chunk (plan-step2.md
 * 10.9 "First-load JS"). The provider imports it at idle after hydration
 * (never under reduced motion) and shares it with the CSS tiles, so the first
 * load carries only the observables, the markup and the composition shell.
 *
 * The page is one flow (full-flow plan 2.1 to 2.3): the panel sticks for the
 * whole flow root and everything after it scrolls over it. One pager pages
 * the row, the focused pack's stops and the move from Closing into the free
 * part: one wheel notch or swipe plays one 1.5 s ease-out cubic move, input
 * locked meanwhile, the page never following a held finger. A down gesture
 * at the row focuses the centred pack.
 *
 * Keys (plan 2.10) go through the same pager in the paged part; in the free
 * part they are the browser's. Focus landing in the row's own UI while the
 * page is off the row pages back to it. While bound, the page's scroll
 * restoration is manual and a reload starts at the row (plan 2.8).
 */
import type { ReactNode } from 'react';
import type {
  ComposeCtx,
  FocusKey,
  SpinPanel,
  StageSpinKit,
  StageSpinSource,
  StageState,
} from './contract';
import type { FocusRun } from './stage-focus-kit';
import { STAGE_DESKTOP_QUERY } from './stage-gate';
import { tileVars } from './StageTile';
import { cancelFrame, frame, type FrameData } from './stage-motion';
import { poseAt, stageOpacity } from './stage-pose';
import { CAPSULE_LEAN, LEAN } from './stage-spin-math';
import { composePose } from './stage-pose-compose';
import { ciaoCopies, ciaoOpacity, ciaoPose } from './stage-spin';
import {
  createFlowInput,
  flowKeyIntent,
  flowLoadStart,
  type FlowInputFrame,
} from './stage-flow-input';

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
  spinPose: ciaoPose,
  spinOpacity: ciaoOpacity,
  copies: ciaoCopies,
  paintTiles(row, host, packs, state, cyArt) {
    const g = geomOf(row, host);
    if (!g) return false;
    const count = packs.length;
    const p = g.desktop ? 'd' : 'm';
    const l = { cx: 0, cy: g.cy, step: g.step, artH: g.artH, artW: g.artW };
    const tiles = row.children;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i] as HTMLElement;
      const pack = packs[i];
      const soldOut = pack?.soldOut ?? false;
      // step 1's vars for both breakpoints (labels, the other breakpoint)...
      const vars = tileVars(i, state, soldOut, cyArt);
      // ...then the breakpoint in use posed as the canvas draws it
      const ctx: ComposeCtx = {
        spin: {
          count,
          turn: 0,
          lean: pack?.ticket ? CAPSULE_LEAN : LEAN,
          spinPose: ciaoPose,
          soldOut,
          exit: state.exit,
          panel: g.panel,
          capsule: !!pack?.ticket,
        },
        spinOpacity: ciaoOpacity,
        compose: composePose,
      };
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
      const pose = poseAt(state, i, lf, g.desktop, soldOut, ctx);
      const op =
        stageOpacity(state, i, g.desktop, count, ctx) *
        (fo ? fo.term.opacity(state.focus, i === fo.ctx.index, fo.ctx) : 1);
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
    values: {
      spin: { set(v: number): void };
      exit: { set(v: number): void };
    } & Record<string, unknown>;
  };
  /** Renders the focused view's blocks over the panel. */
  ui?: (node: ReactNode) => void;
};

export type SpinControl = {
  /** The page's flow, or null (unbound). */
  bind(src: StageSpinSource | null): void;
  wake(): void;
  stop(): void;
};

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
  let focusLoad: Promise<FocusRun | null> | null = null;
  const centre = () => Math.round(stage.state.track);
  const input = createFlowInput({
    centreKinds: () => focus?.kindsAt(centre()) ?? null,
    focused: () => !!focus?.active(),
    kinds: () => focus?.kinds() ?? [],
    enter: () => !!focus?.enter(centre(), { how: 'scroll', page: false }),
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
    const on =
      !rmq.matches && !src.empty && (was || window.scrollY <= r0 + panel / 2);
    if (on !== was) src.flow.toggleAttribute('data-flow-on', on);
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
    const keep = input.measure(
      on ? { top: r0, panel, viewport: window.innerHeight, exit } : null,
      window.scrollY,
    );
    if (keep !== null) window.scrollTo(0, keep);
    wake();
  };

  /** The panel past Closing: the focused pack fades, and is hidden in the free part. */
  let shownFade = -1;
  let hidden = false;
  const setFade = (f: FlowInputFrame, y: number) => {
    const panel = src?.panel;
    const t = input.table();
    if (!panel || !t) return;
    const fade = Math.round(f.fade * 1000) / 1000;
    if (fade !== shownFade) {
      shownFade = fade;
      if (fade > 0) panel.style.setProperty('--flow-fade', String(1 - fade));
      else panel.style.removeProperty('--flow-fade');
    }
    const free = y >= t.exitEnd - 0.5;
    if (free !== hidden) {
      hidden = free;
      src?.flow.toggleAttribute('data-flow-free', free);
    }
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
    if (f.scrollTo !== null && Math.abs(f.scrollTo - window.scrollY) >= 0.5)
      window.scrollTo(0, f.scrollTo);
    const y = window.scrollY;
    const p =
      f.at === null ? 0 : f.at.zone === 'paged' ? f.at.p : f.focus + f.fade;
    if (trace && trace.push([t, y, p]) > 4000) trace.splice(0, 2000);
    setFade(f, y);
    const rest = focus?.active()
      ? focus.frame(t, {
          focus: f.focus,
          target: f.target,
          animating: f.animating,
          idle: f.idle,
          past: f.past,
        })
      : true;
    if (f.idle && rest && t - wokeAt > 250) stopLoop();
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
  const onWheel = (e: WheelEvent) => {
    if (!flowOn() || e.ctrlKey || !armed(e.target)) return;
    if (held()) {
      e.preventDefault();
      return;
    }
    // a down notch at the row before the focused view has loaded: load it
    if (!focus) void loadFocus();
    gestures?.push(now());
    if (input.wheel(wheelPx(e), e.deltaX, e.shiftKey, window.scrollY, now()))
      e.preventDefault();
    wake();
  };
  const onTouchStart = (e: TouchEvent) => {
    const p = e.touches[0];
    if (!flowOn() || !p || e.touches.length > 1 || !armed(e.target)) {
      touching = false;
      return;
    }
    touching = true;
    if (!focus) void loadFocus();
    const el = e.target instanceof Element ? e.target : null;
    // a sideways touch on the Top Hits strip, or on the row at rest, is theirs
    const strip =
      !!el?.closest('[data-focus-strip]') ||
      (!focus?.active() && !!el?.closest('[data-stage-viewport]'));
    input.touchStart(p.clientX, p.clientY, window.scrollY, now(), { strip });
    wake();
  };
  let touching = false;
  const onTouchMove = (e: TouchEvent) => {
    const p = e.touches[0];
    if (!touching || !p || e.touches.length > 1) return;
    if (
      (held() ||
        input.touchMove(p.clientX, p.clientY, window.scrollY, now())) &&
      e.cancelable
    )
      e.preventDefault();
  };
  const onTouchEnd = () => {
    if (!touching) return;
    touching = false;
    if (held()) return;
    gestures?.push(now());
    input.touchEnd(window.scrollY, now());
    wake();
  };
  const active = { passive: false } as const;
  const quiet = { passive: true } as const;
  window.addEventListener('wheel', onWheel, active);
  window.addEventListener('touchstart', onTouchStart, quiet);
  window.addEventListener('touchmove', onTouchMove, active);
  window.addEventListener('touchend', onTouchEnd, quiet);
  window.addEventListener('touchcancel', onTouchEnd, quiet);
  window.addEventListener('scroll', wake, quiet);
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
    const packs = tiles.map((t) => ({
      soldOut: !!t.getAttribute('aria-label')?.endsWith(', sold out'),
      ticket: false,
    }));
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
  const loadFocus = (): Promise<FocusRun | null> => {
    if (!host.ui) return Promise.resolve(null);
    focusLoad ??= import(
      /* webpackChunkName: "pack-stage-focus" */ './stage-focus-kit'
    ).then(
      (m) => {
        const s = src;
        if (!s || !host.ui) return null;
        focus = m.createFocusRun({
          src: s,
          state: stage.state,
          wake: stage.wake,
          values: stage.values as Parameters<
            typeof m.createFocusRun
          >[0]['values'],
          ui: host.ui,
          loop: wake,
          go,
          busy: () => input.busy(),
          stops: () => input.stops(),
          paint: paintRow,
          ended: () => {
            shownFade = -1;
            measure();
          },
        });
        return focus;
      },
      () => null,
    );
    return focusLoad;
  };
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
    void loadFocus().then((f) => {
      tapping = false;
      if (f?.active()) return;
      // not focusable (no data for it): today's pack page
      if (!f || !f.enter(index)) {
        const a = tile.querySelector<HTMLAnchorElement>('a[href]');
        if (a) window.location.assign(a.href);
      }
    });
  };
  let tapping = false;
  const preload = () => void loadFocus();
  // The flow's keys (plan 2.10): never while a field, the Top Hits strip
  // or a dialog has focus, never Space on a control, never a key a part of
  // the page already took (the row's own arrows, the sort panel).
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !flowOn() || !input.table()) return;
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
    if (
      e.key === ' ' &&
      t?.closest('button,a[href],[role="button"],summary,label')
    )
      return;
    // the leave is under way: every key waits for it
    if (held()) {
      e.preventDefault();
      return;
    }
    // a key at the row before the focused view has loaded: load it
    if (!focus) void loadFocus();
    const r = input.key(intent, window.scrollY, now());
    if (r === 'free') return;
    e.preventDefault();
    if (r === 'leave') focus?.leave();
    wake();
  };
  // Keyboard users keep every control (nothing is inert): focus landing in
  // the row's own UI while the page is off the row brings it back there (a
  // focused pack leaves; past the details nothing is focusable in the panel).
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
  /** The page's own restoration mode, put back when the flow unbinds. */
  let restoration: ScrollRestoration | null = null;
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
  const resume = () => {
    if (!atEntry() || !flowOn()) return;
    void loadFocus().then((f) => f?.resume());
  };

  const bind = (next: StageSpinSource | null) => {
    if (next === src) return;
    unbindPage?.();
    unbindPage = null;
    if (!next && restoration !== null) {
      window.history.scrollRestoration = restoration;
      restoration = null;
    }
    if (src) {
      src.flow.removeAttribute('data-flow-on');
      src.flow.removeAttribute('data-flow-free');
      src.panel.style.removeProperty('--flow-fade');
      shownFade = -1;
      hidden = false;
    }
    src = next;
    if (next) {
      // no restored scroll: a reload or a history load starts at the row
      if (restoration === null) {
        restoration = window.history.scrollRestoration;
        window.history.scrollRestoration = 'manual';
      }
      startAtRow(next);
      const ro = new ResizeObserver(measure);
      ro.observe(next.flow);
      ro.observe(next.panel);
      next.panel.addEventListener('focusin', onFocusIn);
      next.panel.addEventListener('click', onTap, { capture: true });
      // a press loads the focused view ahead of its tap (when idle has not yet)
      next.panel.addEventListener('pointerdown', preload, quiet);
      setTimeout(resume, 0);
      unbindPage = () => {
        ro.disconnect();
        next.panel.removeEventListener('focusin', onFocusIn);
        next.panel.removeEventListener('click', onTap, { capture: true });
        next.panel.removeEventListener('pointerdown', preload);
      };
      measure();
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
    });
  }

  return {
    bind,
    wake,
    stop() {
      clearTimeout(idleLoad);
      focus?.stop();
      window.removeEventListener('keydown', onKey);
      bind(null);
      stopLoop();
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('scroll', wake);
      window.removeEventListener('resize', measure);
      rmq.removeEventListener('change', measure);
    },
  };
}
