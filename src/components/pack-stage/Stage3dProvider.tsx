'use client';

/**
 * Pack stage 3D provider (plan sections 3-5). Owns the one canvas, the gate,
 * the ONLY dynamic import of the three.js runtime, the frame loop, the layout
 * measure, the `data-live` flags, the watchdog and every observer.
 *
 * The engine is a plain class outside React: React only sees `mode` and
 * `ready` (through `useSyncExternalStore`). Everything else on the API is
 * identity-stable, and `attach` / `start` are idempotent so StrictMode's
 * double effects and a same-tick detach/attach on a category switch are safe.
 *
 * Page usage (WP-A):
 *   <Stage3dProvider override={stage} debug={debug}>      // preview passes ?stage=, ?debug=
 *     <section className="relative">                      // the stage section only
 *       <Stage3dCanvas />                                 // first child, under the tiles
 *       ...tiles...
 *     </section>
 *   </Stage3dProvider>
 *   const stage = useStage3d();
 *   useEffect(() => stage.attach({ categoryId, packs, artElement, track }), [...]);
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  animate,
  cancelFrame,
  frame,
  motionValue,
  type frameData,
  type MotionValue,
} from 'motion/react';

import type {
  CreateStageRuntime,
  Stage3dStage,
  StageLayout,
  StageMode,
  StageRuntime,
  StageRuntimeFailReason,
  StageRuntimeModule,
  StageRuntimePack,
  StageRuntimeStats,
  StageSlotSource,
  StageSlotSourceWithLayout,
  StageState,
} from './contract';
import {
  armBootGuard,
  markCrashed,
  readCrashFlag,
  type BootGuard,
} from './crash-guard';
import {
  REDUCED_MOTION_QUERY,
  STAGE_DESKTOP_QUERY,
  browserGateEnv,
  createFrameWatchdog,
  gateStage,
  type StageOverride,
} from './stage-gate';
import {
  INTRO_TOTAL_MS,
  STAGE_SPRING_BEZIER,
  SWAP_RISE_MS,
  SWAP_SINK_MS,
  restState,
} from './stage-pose';

// ---------------------------------------------------------------------------
// The dynamic import boundary.
//
// The ONLY place the three.js runtime is reached: its own async chunk, loaded
// after the gate passes (never for reduced motion, save-data, no WebGL2 or a
// crash flag).
function loadRuntime(): Promise<StageRuntimeModule> {
  return import(
    /* webpackChunkName: "pack-stage-3d" */ './runtime/stage-runtime'
  );
}

// ---------------------------------------------------------------------------

/** Idle motion stops this long after the last input, then eases to rest. */
const IDLE_TIMEOUT_MS = 10_000;
/** A value change this recent counts as "animating" (keeps the loop awake). */
const ACTIVE_WINDOW_MS = 120;
/** Hidden or out of view this long: textures are released. */
const RELEASE_AFTER_MS = 60_000;
const DPR_CAP_FULL = 2;
const DPR_CAP_LITE = 1.5;
const POINTER_IN_S = 0.35;
const POINTER_OUT_S = 0.6;
type Bezier = [number, number, number, number];
const SWAP_SINK_EASE: Bezier = [0.4, 0, 1, 1];
const SPRING_EASE: Bezier = [...STAGE_SPRING_BEZIER];

type Snapshot = { mode: StageMode; ready: boolean };
type FrameInfo = typeof frameData;
type Controls = ReturnType<typeof animate>;

const SERVER_SNAPSHOT: Snapshot = Object.freeze({
  mode: 'pending',
  ready: false,
});

function prefersReduced(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia(REDUCED_MOTION_QUERY).matches
    );
  } catch {
    return false;
  }
}

function matchesQuery(q: string): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia(q).matches;
  } catch {
    return false;
  }
}

/** Untransformed offset of `el` relative to `root` (an offsetParent in its chain). */
function offsetTo(
  el: HTMLElement,
  root: Element,
): { x: number; y: number } | null {
  let x = 0;
  let y = 0;
  let n: HTMLElement | null = el;
  while (n) {
    x += n.offsetLeft;
    y += n.offsetTop;
    const p: Element | null = n.offsetParent;
    if (p === root) return { x, y };
    if (!(p instanceof HTMLElement)) return null;
    x += p.clientLeft;
    y += p.clientTop;
    n = p;
  }
  return null;
}

/**
 * One-shot layout measure, host CSS px, from untransformed metrics (offset
 * chain), so CSS poses, the drag translation and the float-in never skew it.
 * Assumption: the centred pack's art is horizontally centred in the host, so
 * `cx = hostWidth / 2`. Returns null when the panel is hidden (zero size).
 */
export function measureStageLayout(
  host: HTMLElement,
  src: StageSlotSource,
  centre: number,
): StageLayout | null {
  const root = host.offsetParent;
  const n = src.packs.length;
  if (!root || n === 0) return null;
  const c = Math.min(n - 1, Math.max(0, centre));
  const art = src.artElement(c);
  if (!art || art.offsetHeight === 0) return null;
  const at = offsetTo(art, root);
  if (!at) return null;
  const hostY = host.offsetTop;
  const artH = art.offsetHeight;
  const cy = at.y - hostY + artH / 2;
  let step = 0;
  const k = c + 1 < n ? c + 1 : c - 1;
  const other = k >= 0 && k !== c ? src.artElement(k) : null;
  if (other) {
    const ot = offsetTo(other, root);
    if (ot) step = Math.abs(ot.x - at.x) / Math.abs(k - c);
  }
  // Tiles stacked in one place (positioned by transform only): no DOM step.
  if (!(step > 0)) step = art.offsetWidth * 1.1;
  return { cx: host.clientWidth / 2, cy, step, artH, artW: art.offsetWidth };
}

function sameSource(a: StageSlotSource, b: StageSlotSource): boolean {
  if (a.categoryId !== b.categoryId || a.track !== b.track) return false;
  if (a.packs === b.packs) return true;
  return (
    a.packs.length === b.packs.length &&
    a.packs.every((p, i) => {
      const q = b.packs[i];
      return (
        q !== undefined &&
        q.id === p.id &&
        q.soldOut === p.soldOut &&
        q.art3d?.frontHalf === p.art3d?.frontHalf
      );
    })
  );
}

class StageEngine {
  readonly state: StageState = restState(0);
  readonly values = {
    intro: motionValue(1),
    swap: motionValue(0),
    pointerX: motionValue(0),
    pointerY: motionValue(0),
  };

  private snap: Snapshot = { mode: 'pending', ready: false };
  private listeners = new Set<() => void>();
  private settledResolve: ((m: StageMode) => void) | null = null;
  private readonly settled: Promise<StageMode>;

  private override: StageOverride = null;
  private debug = false;
  private started = false;
  private gen = 0;
  private failedForPage = false;

  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private source: StageSlotSourceWithLayout | null = null;
  private sourceIndex = new Map<string, number>();
  private trackUnsub: (() => void) | null = null;
  private pendingDetach: StageSlotSource | null = null;
  private layout: StageLayout | null = null;

  private createFn: CreateStageRuntime | null = null;
  private runtime: StageRuntime | null = null;
  private runtimeToken = 0;
  private tier: 'full' | 'lite' = 'full';
  private desktop = false;
  /** prepare() called for the current runtime / resolved for it. */
  private prepared = false;
  private prepDone = false;
  private liveCapable = false;
  private bootGuard: BootGuard | null = null;

  private running = false;
  private prevTs: number | null = null;
  private lastInput = 0;
  private rested = false;
  private live = new Set<string>();
  private watchdog = createFrameWatchdog();
  private watchdogOn = true;

  private inView = true;
  private released = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  private cleanups: (() => void)[] = [];
  private hostCleanups: (() => void)[] = [];
  private introStop: (() => void) | null = null;
  private swapStop: (() => void) | null = null;
  private swapSeq = 0;
  private pointerAnims: [Controls | null, Controls | null] = [null, null];
  private hostRect: DOMRect | null = null;

  constructor() {
    this.settled = new Promise<StageMode>((r) => {
      this.settledResolve = r;
    });
    // Mirror the motion values into the plain state the canvas reads.
    this.values.intro.on('change', (v) => {
      this.state.intro = v;
      this.poke();
    });
    this.values.swap.on('change', (v) => {
      this.state.swap = v;
      this.poke();
    });
    this.values.pointerX.on('change', (v) => {
      this.state.pointerX = v;
      this.poke();
    });
    this.values.pointerY.on('change', (v) => {
      this.state.pointerY = v;
      this.poke();
    });
  }

  // --- React glue ---------------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = (): Snapshot => this.snap;
  getServerSnapshot = (): Snapshot => SERVER_SNAPSHOT;

  private setSnap(mode: StageMode, ready: boolean) {
    if (this.snap.mode === mode && this.snap.ready === ready) return;
    this.snap = { mode, ready };
    if (ready && (mode === 'flat' || this.prepared))
      this.settledResolve?.(mode);
    for (const fn of this.listeners) fn();
  }

  // --- Public API (identity-stable) --------------------------------------

  whenSettled = (): Promise<StageMode> => this.settled;

  stats = (): StageRuntimeStats | null => {
    try {
      return this.runtime?.stats() ?? null;
    } catch {
      return null;
    }
  };

  wake = () => {
    this.poke();
  };

  /**
   * Idempotent. Re-attaching an EQUIVALENT source (same category, same packs
   * array, same track value) only adopts the new object (its `artElement`):
   * no texture reload, no `data-live` flicker. Detach is deferred one
   * microtask so effect cleanup -> re-run (StrictMode, a dependency change)
   * lands on that path instead of a dispose and reload.
   */
  attach = (src: StageSlotSource): (() => void) => {
    const s = src as StageSlotSourceWithLayout;
    const cur = this.source;
    if (cur && cur !== s && sameSource(cur, s)) {
      this.source = s;
      this.pendingDetach = null;
    } else if (cur !== s) {
      this.pendingDetach = null;
      this.detachSource();
      this.source = s;
      this.sourceIndex = new Map(s.packs.map((p, i) => [p.id, i]));
      this.liveCapable = s.packs.some((p) => p.art3d !== null);
      this.state.track = s.track.get();
      this.trackUnsub = s.track.on('change', (v) => {
        this.state.track = v;
        this.poke();
      });
      this.pushPacks();
    } else {
      this.pendingDetach = null;
    }
    this.measure();
    this.maybePrepare();
    this.poke();
    return () => {
      if (this.source !== s) return;
      this.pendingDetach = s;
      queueMicrotask(() => {
        if (this.pendingDetach !== s || this.source !== s) return;
        this.pendingDetach = null;
        this.detachSource();
        const rt = this.runtime;
        if (rt) this.safe(() => rt.setPacks(null));
      });
    };
  };

  holdIntro = () => {
    this.introStop?.();
    this.values.intro.set(0);
  };

  playIntro = (): Promise<void> => {
    this.introStop?.();
    if (prefersReduced()) {
      this.values.intro.set(1);
      return Promise.resolve();
    }
    this.values.intro.set(0);
    return this.run(
      this.values.intro,
      1,
      { duration: INTRO_TOTAL_MS / 1000, ease: 'linear' },
      (stop) => {
        this.introStop = stop;
      },
    ).then(() => undefined);
  };

  swapCategory = async (apply: () => void): Promise<void> => {
    const seq = ++this.swapSeq;
    this.swapStop?.();
    if (prefersReduced()) {
      apply();
      this.values.swap.set(0);
      return;
    }
    const sunk = await this.run(
      this.values.swap,
      1,
      { duration: SWAP_SINK_MS / 1000, ease: SWAP_SINK_EASE },
      (stop) => {
        this.swapStop = stop;
      },
    );
    if (seq !== this.swapSeq) return; // superseded: the newer call applies its own
    void sunk;
    apply();
    await this.run(
      this.values.swap,
      0,
      { duration: SWAP_RISE_MS / 1000, ease: SPRING_EASE },
      (stop) => {
        this.swapStop = stop;
      },
    );
  };

  /** Animate a value; resolves true when complete, false when stopped. */
  private run(
    mv: MotionValue<number>,
    to: number,
    opts: {
      duration: number;
      ease: 'linear' | Bezier;
    },
    setStop: (stop: () => void) => void,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      const c = animate(mv, to, {
        duration: opts.duration,
        ease: opts.ease,
        onComplete: () => finish(true),
      });
      setStop(() => {
        c.stop();
        finish(false);
      });
    });
  }

  // --- Host (from <Stage3dCanvas/>) --------------------------------------

  setHost = (el: HTMLElement | null) => {
    if (el === this.host) return;
    this.unbindHost();
    if (this.runtime) this.teardownRuntime(true);
    this.host = el;
    if (!el || !this.started) return;
    this.bindHost(el);
    if (this.createFn && !this.failedForPage) this.createRuntime();
  };

  // --- Lifecycle -----------------------------------------------------------

  start(opts: { override: StageOverride; debug: boolean }) {
    if (this.started) return;
    this.started = true;
    const gen = ++this.gen;
    this.override = opts.override;
    this.debug = opts.debug;
    this.watchdogOn = opts.override === null;
    if (this.host) this.bindHost(this.host);
    this.bindDocument();
    if (this.debug) this.exposeDebug();

    if (this.failedForPage) {
      this.settleFlat();
      return;
    }
    const mode = gateStage(browserGateEnv(), {
      crashFlag: readCrashFlag(),
      override: opts.override,
    });
    if (mode === 'flat') {
      this.settleFlat();
      return;
    }
    this.tier = mode === 'lite' ? 'lite' : 'full';
    loadRuntime().then(
      (mod) => {
        if (gen !== this.gen || this.failedForPage) return;
        // No <Stage3dCanvas/> mounted: settle flat rather than hold the loader.
        if (!this.host) {
          this.settleFlat();
          return;
        }
        this.createFn = mod.createStageRuntime;
        this.createRuntime();
      },
      () => {
        // Chunk failed to load (or not wired yet): flat, but not a crash.
        if (gen === this.gen) this.settleFlat();
      },
    );
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.gen++;
    this.teardownRuntime(true);
    this.unbindHost();
    for (const c of this.cleanups.splice(0)) c();
    this.clearReleaseTimer();
    this.introStop?.();
    this.swapStop?.();
    for (const a of this.pointerAnims) a?.stop();
    if (this.debug && typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>).__packStage;
    }
  }

  private settleFlat() {
    this.createFn = null;
    this.teardownRuntime(true);
    this.setSnap('flat', true);
  }

  // --- Runtime ---------------------------------------------------------------

  private createRuntime() {
    const create = this.createFn;
    const host = this.host;
    // No host yet: `setHost` creates it when <Stage3dCanvas/> mounts.
    if (!create || !host || this.runtime) return;
    const token = ++this.runtimeToken;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
    host.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas = canvas;
    this.desktop = matchesQuery(STAGE_DESKTOP_QUERY);
    this.prepared = false;

    this.bootGuard?.cancel();
    this.bootGuard = armBootGuard();
    let rt: StageRuntime;
    try {
      rt = create({
        canvas,
        tier: this.tier,
        desktop: this.desktop,
        failIfMajorPerformanceCaveat: this.override === null,
        onFail: (r) => {
          if (token === this.runtimeToken) this.fail(r);
        },
      });
    } catch {
      this.fail('error');
      return;
    }
    // onFail fired synchronously inside create(): the engine already fell back.
    if (token !== this.runtimeToken || this.failedForPage) {
      try {
        rt.dispose();
      } catch {
        // Already broken; nothing else holds it.
      }
      return;
    }
    this.runtime = rt;
    // A rebuild (lite step-down, breakpoint) keeps `ready`; a first boot waits for prepare().
    this.setSnap(this.tier === 'lite' ? 'lite' : '3d', this.snap.ready);
    this.resizeNow();
    this.measure();
    this.pushPacks();
    this.maybePrepare();
  }

  private maybePrepare() {
    const rt = this.runtime;
    if (!rt || this.prepared || !this.source) return;
    this.prepared = true; // in flight
    const token = this.runtimeToken;
    let p: Promise<void>;
    try {
      // Boot the packs around the attached track (the start pack), not pack 0.
      p = rt.prepare(this.state.track);
    } catch {
      this.fail('error');
      return;
    }
    p.then(
      () => {
        if (token !== this.runtimeToken) return;
        this.prepDone = true;
        this.setSnap(this.tier === 'lite' ? 'lite' : '3d', true);
        this.poke();
      },
      () => {
        if (token === this.runtimeToken) this.fail('error');
      },
    );
  }

  private fail(reason: StageRuntimeFailReason) {
    if (this.failedForPage) return;
    if (reason === 'too-slow') {
      if (this.runtime) this.stepDown();
      return;
    }
    this.failedForPage = true;
    this.teardownRuntime(false);
    markCrashed();
    this.setSnap('flat', true);
  }

  /** Watchdog verdict: 3d -> lite (rebuild, tier is fixed per runtime) -> flat. */
  private stepDown() {
    if (this.tier === 'full' && this.createFn) {
      this.tier = 'lite';
      this.teardownRuntime(true);
      this.watchdog.reset();
      this.createRuntime();
      return;
    }
    this.failedForPage = true;
    this.teardownRuntime(true);
    this.setSnap('flat', true);
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.fail('context-lost');
  };

  /** `clean`: a normal teardown clears the boot flag; a crash leaves it to `markCrashed`. */
  private teardownRuntime(clean: boolean) {
    this.sleep();
    this.runtimeToken++;
    if (this.bootGuard) {
      if (clean) this.bootGuard.settle();
      else this.bootGuard.cancel();
      this.bootGuard = null;
    }
    const rt = this.runtime;
    this.runtime = null;
    this.prepared = false;
    this.prepDone = false;
    this.released = false;
    if (rt) this.safe(() => rt.dispose());
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
      this.canvas.remove();
      this.canvas = null;
    }
    this.resetLive();
  }

  private safe(fn: () => void) {
    try {
      fn();
    } catch {
      if (this.runtime) this.fail('error');
    }
  }

  private pushPacks() {
    const rt = this.runtime;
    if (!rt || this.released) return;
    const src = this.source;
    const list: StageRuntimePack[] = [];
    if (src) {
      src.packs.forEach((p, index) => {
        if (p.art3d)
          list.push({ id: p.id, art: p.art3d, soldOut: p.soldOut, index });
      });
    }
    this.resetLive();
    this.watchdog.hold(performance.now());
    this.safe(() => rt.setPacks(list.length > 0 ? list : null));
  }

  private measure() {
    const host = this.host;
    const src = this.source;
    if (!host || !src) return;
    let l: StageLayout | null = null;
    try {
      l =
        src.layout?.() ??
        measureStageLayout(host, src, Math.round(this.state.track));
    } catch {
      l = null;
    }
    if (!l) return; // hidden panel: keep the previous layout, re-measured on resize
    this.layout = l;
    const rt = this.runtime;
    if (rt) this.safe(() => rt.setLayout(l));
  }

  private resizeNow() {
    const host = this.host;
    const rt = this.runtime;
    if (!host || !rt) return;
    const cap = this.tier === 'lite' ? DPR_CAP_LITE : DPR_CAP_FULL;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    this.safe(() => rt.resize(host.clientWidth, host.clientHeight, dpr));
    this.watchdog.hold(performance.now());
  }

  // --- data-live -------------------------------------------------------------

  private setLive(id: string, on: boolean) {
    const i = this.sourceIndex.get(id);
    if (i === undefined || !this.source) return;
    const el = this.source.artElement(i);
    if (el) el.dataset.live = on ? '1' : '0';
  }

  private applyLive(ids: readonly string[], now: number) {
    const next = new Set(ids);
    for (const id of this.live) if (!next.has(id)) this.setLive(id, false);
    for (const id of next) {
      if (!this.live.has(id)) {
        this.setLive(id, true);
        this.watchdog.hold(now); // a texture just arrived: skip upload stalls
      }
    }
    this.live = next;
  }

  private resetLive() {
    for (const id of this.live) this.setLive(id, false);
    this.live = new Set();
  }

  private detachSource() {
    this.resetLive();
    this.trackUnsub?.();
    this.trackUnsub = null;
    this.source = null;
    this.sourceIndex = new Map();
    this.liveCapable = false;
  }

  // --- Frame loop ------------------------------------------------------------

  /** Input or animation: restart the idle timer and wake the loop. */
  private poke() {
    this.lastInput = performance.now();
    this.rested = false;
    this.schedule();
  }

  private canRun(): boolean {
    return (
      this.runtime !== null &&
      this.prepDone &&
      this.liveCapable &&
      !this.released &&
      this.inView &&
      typeof document !== 'undefined' &&
      !document.hidden
    );
  }

  private schedule() {
    if (this.running || !this.canRun()) return;
    this.running = true;
    this.prevTs = null;
    this.watchdog.hold(performance.now());
    frame.render(this.tick, true);
  }

  private sleep() {
    if (!this.running) return;
    cancelFrame(this.tick);
    this.running = false;
    this.prevTs = null;
  }

  private tick = (data: FrameInfo) => {
    const rt = this.runtime;
    if (!rt || !this.canRun()) {
      this.sleep();
      return;
    }
    const now = data.timestamp;
    if (this.prevTs !== null) {
      const dt = now - this.prevTs;
      if (this.watchdogOn && this.watchdog.sample(dt, now)) {
        this.fail('too-slow');
        return;
      }
      this.advanceIdle(dt, now);
    }
    this.prevTs = now;
    let out: { live: string[]; wantsFrame: boolean };
    try {
      out = rt.render(this.state, now);
    } catch {
      this.fail('error');
      return;
    }
    this.applyLive(out.live, now);
    const active = now - this.lastInput < ACTIVE_WINDOW_MS;
    if (!out.wantsFrame && !active && this.rested) this.sleep();
  };

  /** Idle clock: runs for 10 s after input, then eases to the next rest point. */
  private advanceIdle(dtMs: number, now: number) {
    const dt = Math.min(dtMs, 100) / 1000;
    const s = this.state;
    if (now - this.lastInput < IDLE_TIMEOUT_MS) {
      s.idle += dt;
      if (s.idle > 606) s.idle -= 600; // keeps float precision; 600 is a whole period
      return;
    }
    if (s.idle === 0) {
      this.rested = true;
      return;
    }
    const target = Math.ceil(s.idle / 3 - 1e-9) * 3;
    const remaining = target - s.idle;
    if (remaining <= 1e-4) {
      s.idle = target;
      this.rested = true;
      return;
    }
    s.idle += Math.min(
      remaining,
      dt * Math.min(1, Math.max(0.08, remaining / 0.6)),
    );
  }

  // --- Observers ---------------------------------------------------------------

  private bindHost(host: HTMLElement) {
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        this.hostRect = null;
        this.resizeNow();
        this.measure();
        this.poke();
      });
      ro.observe(host);
      this.hostCleanups.push(() => ro.disconnect());
    }
    if (typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        this.inView = entry.isIntersecting;
        this.onPresence();
      });
      io.observe(host);
      this.hostCleanups.push(() => io.disconnect());
    }
    // Pointer lean: the host is pointer-events:none, so listen on its parent.
    const stage = host.parentElement;
    if (stage && matchesQuery('(pointer: fine)') && !prefersReduced()) {
      const move = (e: PointerEvent) => {
        if (e.pointerType !== 'mouse') return;
        const r = (this.hostRect ??= host.getBoundingClientRect());
        if (r.width === 0 || r.height === 0) return;
        const x = Math.max(
          -1,
          Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1),
        );
        const y = Math.max(
          -1,
          Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1),
        );
        this.leanTo(x, y, POINTER_IN_S);
      };
      const leave = () => this.leanTo(0, 0, POINTER_OUT_S);
      const invalidate = () => {
        this.hostRect = null;
      };
      stage.addEventListener('pointermove', move, { passive: true });
      stage.addEventListener('pointerleave', leave);
      window.addEventListener('scroll', invalidate, {
        passive: true,
        capture: true,
      });
      this.hostCleanups.push(() => {
        stage.removeEventListener('pointermove', move);
        stage.removeEventListener('pointerleave', leave);
        window.removeEventListener('scroll', invalidate, { capture: true });
      });
    }
  }

  private unbindHost() {
    for (const c of this.hostCleanups.splice(0)) c();
    this.hostRect = null;
    this.inView = true;
  }

  private leanTo(x: number, y: number, duration: number) {
    this.pointerAnims[0]?.stop();
    this.pointerAnims[1]?.stop();
    this.pointerAnims = [
      animate(this.values.pointerX, x, { duration, ease: 'easeOut' }),
      animate(this.values.pointerY, y, { duration, ease: 'easeOut' }),
    ];
  }

  private bindDocument() {
    if (typeof document === 'undefined') return;
    const onVis = () => this.onPresence();
    document.addEventListener('visibilitychange', onVis);
    this.cleanups.push(() =>
      document.removeEventListener('visibilitychange', onVis),
    );
    try {
      const mql = window.matchMedia(STAGE_DESKTOP_QUERY);
      const onDesktop = () => {
        // `desktop` is fixed per runtime: rebuild across the breakpoint.
        if (this.runtime && mql.matches !== this.desktop) {
          this.teardownRuntime(true);
          this.createRuntime();
        }
      };
      mql.addEventListener('change', onDesktop);
      this.cleanups.push(() => mql.removeEventListener('change', onDesktop));
    } catch {
      // No matchMedia: the breakpoint never changes.
    }
  }

  /** Visibility or intersection changed. */
  private onPresence() {
    const present = this.inView && !document.hidden;
    if (present) {
      this.clearReleaseTimer();
      if (this.released) {
        this.released = false;
        this.pushPacks();
      }
      this.poke();
      return;
    }
    this.sleep();
    if (this.releaseTimer === null && this.runtime) {
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null;
        const rt = this.runtime;
        if (!rt || (this.inView && !document.hidden)) return;
        this.resetLive();
        this.safe(() => rt.setPacks(null));
        this.released = true;
      }, RELEASE_AFTER_MS);
    }
  }

  private clearReleaseTimer() {
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  /** `?debug=1`: `window.__packStage` for QA scripts. */
  private exposeDebug() {
    if (typeof window === 'undefined') return;
    (window as unknown as Record<string, unknown>).__packStage = {
      mode: () => this.snap.mode,
      ready: () => this.snap.ready,
      tier: () => this.tier,
      layout: () => this.layout,
      live: () => [...this.live],
      running: () => this.running,
      state: this.state,
      stats: this.stats,
      wake: this.wake,
    };
  }
}

// ---------------------------------------------------------------------------
// React surface

const noop = () => {};

function makeFlatApi(): Stage3dStage {
  return {
    mode: 'flat',
    ready: true,
    state: restState(0),
    values: {
      intro: motionValue(1),
      swap: motionValue(0),
      pointerX: motionValue(0),
      pointerY: motionValue(0),
    },
    attach: () => noop,
    wake: noop,
    whenSettled: () => Promise.resolve('flat'),
    holdIntro: noop,
    playIntro: () => Promise.resolve(),
    swapCategory: async (apply) => apply(),
    stats: () => null,
  };
}

/** Outside a provider: flat and ready, so tiles render on their own. */
const FLAT_API = makeFlatApi();

const Stage3dContext = createContext<Stage3dStage>(FLAT_API);
const EngineContext = createContext<StageEngine | null>(null);

export function Stage3dProvider({
  children,
  override = null,
  debug = false,
}: {
  children: ReactNode;
  /** Preview only: `?stage=flat|3d|lite`, passed in by the server page. */
  override?: StageOverride;
  /** Preview only: `?debug=1` exposes `window.__packStage`. */
  debug?: boolean;
}) {
  const [engine] = useState(() => new StageEngine());
  const snap = useSyncExternalStore(
    engine.subscribe,
    engine.getSnapshot,
    engine.getServerSnapshot,
  );

  useEffect(() => {
    engine.start({ override, debug });
    return () => engine.stop();
  }, [engine, override, debug]);

  const api = useMemo<Stage3dStage>(
    () => ({
      mode: snap.mode,
      ready: snap.ready,
      state: engine.state,
      values: engine.values,
      attach: engine.attach,
      wake: engine.wake,
      whenSettled: engine.whenSettled,
      holdIntro: engine.holdIntro,
      playIntro: engine.playIntro,
      swapCategory: engine.swapCategory,
      stats: engine.stats,
    }),
    [engine, snap],
  );

  return (
    <EngineContext.Provider value={engine}>
      <Stage3dContext.Provider value={api}>{children}</Stage3dContext.Provider>
    </EngineContext.Provider>
  );
}

export function useStage3d(): Stage3dStage {
  return useContext(Stage3dContext);
}

/**
 * The one canvas host. Place it as the first child of the stage section
 * (which must be `position: relative` and cover the stage only), under the
 * tiles. The provider creates and removes the `<canvas>` inside it.
 */
export function Stage3dCanvas({ className }: { className?: string }) {
  const engine = useContext(EngineContext);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      engine?.setHost(el);
    },
    [engine],
  );
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-stage-canvas=""
      className={`pointer-events-none absolute inset-0${className ? ` ${className}` : ''}`}
    />
  );
}
