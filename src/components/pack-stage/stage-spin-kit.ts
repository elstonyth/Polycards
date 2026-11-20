/**
 * Pack stage, step 2: the scroll spin's lazily loaded chunk (plan-step2.md
 * 10.9 "First-load JS"). The provider imports it at idle after hydration
 * (never under reduced motion) and shares it with the CSS tiles, so the first
 * load carries only the observables, the markup and the composition shell.
 *
 * The row is Ciao's packshot row (owner, 2026-11-20: "Ciao look"): fronts
 * only, the pitch ramp seen through Ciao's camera, repeated to run off both
 * edges, leaving through the camera move. The driver is Ciao's paging by
 * only behaviour (owner: one version): one wheel notch or swipe plays one
 * 1.5 s ease-out cubic move, input locked meanwhile, the page never following
 * a held finger.
 */
import type { ReactNode } from 'react';
import type {
  ComposeCtx,
  SpinPanel,
  SpinRange,
  StageSpinKit,
  StageSpinSource,
  StageState,
} from './contract';
import type { FocusRun } from './stage-focus-kit';
import { STAGE_DESKTOP_QUERY } from './stage-gate';
import { tileVars } from './StageTile';
import { cancelFrame, frame, type FrameData } from './stage-motion';
import { poseAt, stageOpacity } from './stage-pose';
import {
  CAPSULE_LEAN,
  LEAN,
  spinFlags,
  spinRangeOf,
  type SpinFlags,
} from './stage-spin-math';
import { composePose } from './stage-pose-compose';
import { ciaoCopies, ciaoOpacity, ciaoPose } from './stage-spin';
import { createSpinDriver, type SpinFrame } from './stage-spin-driver';

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
        (fo ? fo.term.opacity(state.focus, i === fo.ctx.index) : 1);
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
   * motion values (the driver writes the spin and the exit; back to 0 on stop).
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
  /** The page's pin, or null (unbound). */
  bind(src: StageSpinSource | null): void;
  wake(): void;
  stop(): void;
  last(): SpinFrame | null;
  range(): SpinRange | null;
  looping(): boolean;
};

/** A wheel delta in px, whatever unit the device reports. */
function wheelPx(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16;
  if (e.deltaMode === 2) return e.deltaY * window.innerHeight;
  return e.deltaY;
}

/**
 * Starts the spin's driver: non-passive wheel and touch listeners (paging
 * cancels the native scroll), one frame loop that reads the scroll, writes it
 * while a move plays, and sets the spin and the exit; it sleeps at rest. For
 * the bound pin it measures the range (the site header's and the tab bar's
 * heights make the panel one screen), sets the panel's CSS flags, and brings
 * keyboard focus landing in the row mid-spin back to the pin's start.
 */
export function startSpin(host: SpinHost): SpinControl {
  const d = createSpinDriver({
    mode: 'paged',
    reducedMotion: false,
    // Ciao's row: the spin IS the scroll's progress (no remap).
    pagedRemap: false,
  });
  const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let src: StageSpinSource | null = null;
  let range: SpinRange | null = null;
  let flags: SpinFlags = { spinning: false, text: false, head: false };
  let key = '';
  let looping = false;
  let wokeAt = 0;
  let last: SpinFrame | null = null;
  let unbindPage: (() => void) | null = null;
  const now = () => performance.now();
  const setSpin = (spin: number, exit: number) => {
    host.stage.values.spin.set(spin);
    host.stage.values.exit.set(exit);
  };
  /** The focused view (its chunk loads at idle after this one, or at a tap). */
  let focus: FocusRun | null = null;
  let focusLoad: Promise<FocusRun | null> | null = null;

  const measure = () => {
    if (!src) return;
    const header = document.querySelector<HTMLElement>('header');
    const tabBar = document.querySelector<HTMLElement>('nav.fixed.bottom-0');
    const top = header?.offsetHeight ?? 0;
    const bottom = tabBar && tabBar.offsetHeight > 0 ? tabBar.offsetHeight : 0;
    src.flow.style.setProperty('--flow-top', `${top}px`);
    src.flow.style.setProperty('--flow-bottom', `${bottom}px`);
    // The pin exists only while this driver runs (the CSS reads
    // data-spin-on). It is switched on only while the visitor is still on
    // the stage, so a page already scrolled down never jumps.
    // focused: the focus owns the scroll (no spin range)
    if (focus?.active()) {
      range = null;
      wake();
      return;
    }
    const wrapTop = src.wrap.getBoundingClientRect().top + window.scrollY;
    const was = src.wrap.hasAttribute('data-spin-on');
    const on =
      !rmq.matches &&
      !src.empty &&
      (was || window.scrollY <= wrapTop - top + src.panel.offsetHeight / 2);
    if (on !== was) src.wrap.toggleAttribute('data-spin-on', on);
    range = on ? spinRangeOf(wrapTop, top, src.panel.offsetHeight) : null;
    wake();
  };

  const setFlags = (spin: number, exit: number) => {
    const el = src?.panel;
    const next = spinFlags(flags, spin, exit);
    if (el) {
      const set = (k: string, on: boolean, was: boolean) => {
        if (on === was) return;
        if (on) el.setAttribute(k, '');
        else el.removeAttribute(k);
      };
      set('data-spinning', next.spinning, flags.spinning);
      set('data-spin-text', next.text, flags.text);
      set('data-spin-head', next.head, flags.head);
    }
    flags = next;
  };

  // Keyboard users keep Open (nothing is inert): focus landing in the row or
  // the info block mid-spin brings the page back to the pin's start (10.4).
  const onFocusIn = (e: FocusEvent) => {
    const t = e.target as HTMLElement | null;
    if (!range || !flags.spinning || !t?.closest) return;
    if (!t.closest('[data-stage-viewport],[data-stage-info]')) return;
    d.reset(last?.spin ?? 0);
    window.scrollTo({ top: range.start, behavior: 'smooth' });
  };

  // Only gestures inside the pin (or on the bare page or the site header)
  // page the spin: sheets, dialogs and the tab bar keep their own scrolling.
  const armed = (t: EventTarget | null): boolean => {
    if (!(t instanceof Node)) return false;
    if (src?.wrap.contains(t)) return true;
    if (t === document.body || t === document.documentElement) return true;
    const e = t instanceof Element ? t : t.parentElement;
    return !!e?.closest('header') && !e.closest('[role="dialog"]');
  };

  /** ?debug=1 only: [time, scrollY after the write, spin] per frame, and gesture times. */
  let trace: number[][] | null = null;
  let gestures: number[] | null = null;

  const tick = (data: FrameData) => {
    if (focus?.active()) {
      const rest = focus.frame(data.timestamp);
      setSpin(0, 0);
      if (rest && data.timestamp - wokeAt > 250) stopLoop();
      return;
    }
    const r = src ? range : null;
    const k = r ? `${r.start}|${r.length}|${r.exit}` : '';
    if (k !== key) {
      key = k;
      d.setRange(r);
    }
    const f = d.frame(window.scrollY, data.timestamp);
    if (f.scrollTo !== null && Math.abs(f.scrollTo - window.scrollY) >= 0.5)
      window.scrollTo(0, f.scrollTo);
    last = f;
    if (trace && trace.push([data.timestamp, window.scrollY, f.spin]) > 4000)
      trace.splice(0, 2000);
    setSpin(f.spin, f.exit);
    setFlags(f.spin, f.exit);
    if (f.idle && data.timestamp - wokeAt > 250) stopLoop();
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

  /** Focused: input that belongs to a dialog (the card overlay, a sheet). */
  const inDialog = (t: EventTarget | null): boolean =>
    !!(t instanceof Element && t.closest('[role="dialog"]')) ||
    !!document.querySelector('[role="dialog"][aria-modal="true"]');
  const onWheel = (e: WheelEvent) => {
    if (focus?.active()) {
      if (!e.ctrlKey && !inDialog(e.target)) focus.wheel(e);
      return;
    }
    if (e.ctrlKey || !armed(e.target)) return;
    gestures?.push(now());
    if (d.wheel(wheelPx(e), window.scrollY, now())) e.preventDefault();
    wake();
  };
  const onTouchStart = (e: TouchEvent) => {
    const p = e.touches[0];
    if (focus?.active()) {
      if (!inDialog(e.target)) focus.touchStart(e);
      return;
    }
    if (!p || e.touches.length > 1 || !armed(e.target)) return;
    d.touchStart(p.clientX, p.clientY, window.scrollY, now());
    wake();
  };
  const onTouchMove = (e: TouchEvent) => {
    const p = e.touches[0];
    if (focus?.active()) {
      if (!inDialog(e.target)) focus.touchMove(e);
      return;
    }
    if (!p || e.touches.length > 1) return;
    if (
      d.touchMove(p.clientX, p.clientY, window.scrollY, now()) &&
      e.cancelable
    )
      e.preventDefault();
  };
  const onTouchEnd = () => {
    if (focus?.active()) {
      focus.touchEnd();
      return;
    }
    gestures?.push(now());
    d.touchEnd(window.scrollY, now());
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

  // ---- The focused view: the same listeners, handed over while focused ----
  const stage = host.stage;
  const paintRow = () => {
    const panel = src?.panel;
    if (!panel || !stage) return;
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
  const loadFocus = (): Promise<FocusRun | null> => {
    if (!stage || !host.ui) return Promise.resolve(null);
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
          top: () => document.querySelector('header')?.offsetHeight ?? 0,
          paint: paintRow,
          ended: () => {
            d.reset(0);
            measure();
          },
        });
        return focus;
      },
      () => null,
    );
    return focusLoad;
  };
  // A plain tap on the centred pack focuses it (the row at rest only).
  const onTap = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const t = e.target as HTMLElement | null;
    const tile = t?.closest?.<HTMLElement>('[data-stage-tile]');
    if (!tile || !stage) return;
    if (focus?.active()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const index = Number(tile.dataset.index);
    if (
      index !== Math.round(stage.state.track) ||
      (last?.spin ?? 0) >= 0.02 ||
      (last?.target ?? 0) >= 0.02 ||
      flags.spinning
    )
      return;
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
        return;
      }
      measure();
    });
  };
  let tapping = false;
  const onKey = (e: KeyboardEvent) => {
    if (focus?.active()) focus.key(e);
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
  const resume = () => {
    if (!atEntry()) return;
    void loadFocus().then((f) => f?.resume());
  };

  const bind = (next: StageSpinSource | null) => {
    if (next === src) return;
    unbindPage?.();
    unbindPage = null;
    if (src) {
      src.wrap.removeAttribute('data-spin-on');
      setFlags(0, 0);
      flags = { spinning: false, text: false, head: false };
    }
    src = next;
    range = null;
    if (next) {
      const ro = new ResizeObserver(measure);
      ro.observe(next.wrap);
      ro.observe(next.panel);
      next.panel.addEventListener('focusin', onFocusIn);
      next.panel.addEventListener('click', onTap, { capture: true });
      setTimeout(resume, 0);
      unbindPage = () => {
        ro.disconnect();
        next.panel.removeEventListener('focusin', onFocusIn);
        next.panel.removeEventListener('click', onTap, { capture: true });
      };
      measure();
    }
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
  }
  if (dbg)
    dbg.spin = () => ({
      kit: true,
      bound: src !== null,
      looping,
      range,
      frame: last,
      flags,
    });

  return {
    bind,
    wake,
    last: () => last,
    range: () => range,
    looping: () => looping,
    stop() {
      setSpin(0, 0);
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
