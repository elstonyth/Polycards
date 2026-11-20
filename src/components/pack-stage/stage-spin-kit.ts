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
import type {
  ComposeCtx,
  SpinPanel,
  SpinRange,
  StageSpinKit,
  StageSpinSource,
} from './contract';
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
      const pose = poseAt(state, i, l, g.desktop, soldOut, ctx);
      const op = stageOpacity(state, i, g.desktop, count, ctx);
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
  /** Writes the spin and the exit (the provider's observables). */
  set(spin: number, exit: number): void;
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

  const measure = () => {
    if (!src) return;
    const header = document.querySelector<HTMLElement>('header');
    const tabBar = document.querySelector<HTMLElement>('nav.fixed.bottom-0');
    const top = header?.offsetHeight ?? 0;
    const bottom = tabBar && tabBar.offsetHeight > 0 ? tabBar.offsetHeight : 0;
    src.flow.style.setProperty('--flow-top', `${top}px`);
    src.flow.style.setProperty('--flow-bottom', `${bottom}px`);
    range =
      rmq.matches || src.empty
        ? null
        : spinRangeOf(
            src.wrap.getBoundingClientRect().top + window.scrollY,
            top,
            src.panel.offsetHeight,
          );
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
    host.set(f.spin, f.exit);
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

  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || !armed(e.target)) return;
    gestures?.push(now());
    if (d.wheel(wheelPx(e), window.scrollY, now())) e.preventDefault();
    wake();
  };
  const onTouchStart = (e: TouchEvent) => {
    const p = e.touches[0];
    if (!p || e.touches.length > 1 || !armed(e.target)) return;
    d.touchStart(p.clientX, p.clientY, window.scrollY, now());
    wake();
  };
  const onTouchMove = (e: TouchEvent) => {
    const p = e.touches[0];
    if (!p || e.touches.length > 1) return;
    if (
      d.touchMove(p.clientX, p.clientY, window.scrollY, now()) &&
      e.cancelable
    )
      e.preventDefault();
  };
  const onTouchEnd = () => {
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

  const bind = (next: StageSpinSource | null) => {
    if (next === src) return;
    unbindPage?.();
    unbindPage = null;
    if (src) {
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
      unbindPage = () => {
        ro.disconnect();
        next.panel.removeEventListener('focusin', onFocusIn);
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
