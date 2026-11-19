/**
 * Pack stage 3D gate (plan section 5): decides `'3d' | 'lite' | 'flat'`.
 *
 * Split for testing: `decideStageMode` is a pure decision over plain signals;
 * `readCheapSignals` and `probeWebGL2` are thin probes over injected
 * `navigator` / `matchMedia` / canvas factories; `gateStage` glues them and
 * only creates a WebGL context when every cheap signal has already passed.
 *
 * The preview-only `?stage=` override is passed in as a value. Nothing here
 * reads the URL, cookies or headers.
 *
 * Also home of the frame-time watchdog maths (pure) and the pre-paint
 * predicate the loader's inline script inlines (plan section 6).
 */
import { STAGE_CRASH_KEY } from './crash-guard';

export type GateMode = '3d' | 'lite' | 'flat';
export type StageOverride = GateMode | null;

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export const REDUCED_DATA_QUERY = '(prefers-reduced-data: reduce)';
export const COARSE_POINTER_QUERY = '(pointer: coarse)';
/** Desktop layout and runtime flag. Tailwind `lg`. */
export const STAGE_DESKTOP_QUERY = '(min-width: 1024px)';
/** `deviceMemory` at or under this: flat. */
export const FLAT_MAX_DEVICE_MEMORY = 2;
/** `deviceMemory` at or under this: starts at lite. */
export const LITE_MAX_DEVICE_MEMORY = 4;

export type CheapSignals = {
  reducedMotion: boolean;
  saveData: boolean;
  reducedData: boolean;
  /** `navigator.deviceMemory` in GB, or null when the browser hides it. */
  deviceMemory: number | null;
  coarsePointer: boolean;
  crashFlag: boolean;
};

export type StageSignals = CheapSignals & {
  /** WebGL2 probe result; null when not probed (a cheap signal already failed). */
  webgl2: boolean | null;
};

/**
 * The visitor's choices (reduced motion, save-data, reduced data) and the
 * crash flag: flat even under the preview's `?stage=3d|lite` override.
 */
export function refuses3d(s: CheapSignals): boolean {
  return s.reducedMotion || s.saveData || s.reducedData || s.crashFlag;
}

/** Cheap rules, no WebGL: false means flat for sure. */
export function cheapAllows3d(s: CheapSignals): boolean {
  if (s.reducedMotion || s.saveData || s.reducedData || s.crashFlag)
    return false;
  if (s.deviceMemory !== null && s.deviceMemory <= FLAT_MAX_DEVICE_MEMORY)
    return false;
  return true;
}

export function decideStageMode(
  s: StageSignals,
  override: StageOverride = null,
): GateMode {
  if (override === 'flat') return 'flat';
  if (override === '3d' || override === 'lite') {
    // Forced for QA: skips the GPU caveat, the memory tiers and the watchdog,
    // but never the visitor's choices or the crash flag, and still needs a
    // WebGL2 context to exist at all.
    if (refuses3d(s)) return 'flat';
    return s.webgl2 === false ? 'flat' : override;
  }
  if (!cheapAllows3d(s)) return 'flat';
  if (s.webgl2 !== true) return 'flat';
  // Owner decision (2026-11-19): phones (coarse pointer) start on the full
  // tier; only low memory, or the watchdog later, steps a device to lite.
  if (s.deviceMemory !== null && s.deviceMemory <= LITE_MAX_DEVICE_MEMORY)
    return 'lite';
  return '3d';
}

type NavigatorLike = {
  connection?: { saveData?: boolean } | null;
  deviceMemory?: number;
};
type MatchMediaLike = (q: string) => { matches: boolean };

export type GateEnv = {
  navigator?: NavigatorLike | null;
  matchMedia?: MatchMediaLike | null;
  /** Creates a detached canvas for the probe. */
  createCanvas?: (() => { getContext(id: string, o?: object): unknown }) | null;
};

function matches(mm: MatchMediaLike | null | undefined, q: string): boolean {
  if (!mm) return false;
  try {
    return mm(q).matches;
  } catch {
    return false;
  }
}

export function readCheapSignals(
  env: GateEnv,
  crashFlag: boolean,
): CheapSignals {
  const nav = env.navigator ?? null;
  let saveData = false;
  let deviceMemory: number | null = null;
  try {
    saveData = nav?.connection?.saveData === true;
    const dm = nav?.deviceMemory;
    deviceMemory = typeof dm === 'number' && Number.isFinite(dm) ? dm : null;
  } catch {
    // Exotic navigator getters: treat as unknown.
  }
  return {
    reducedMotion: matches(env.matchMedia, REDUCED_MOTION_QUERY),
    saveData,
    reducedData: matches(env.matchMedia, REDUCED_DATA_QUERY),
    deviceMemory,
    coarsePointer: matches(env.matchMedia, COARSE_POINTER_QUERY),
    crashFlag,
  };
}

type LoseContextExt = { loseContext(): void } | null;
type ProbeContext = { getExtension(name: string): unknown };

/**
 * True when a WebGL2 context can be created. `caveat` asks for
 * `failIfMajorPerformanceCaveat` (software GPUs fail). The probe context is
 * released through `WEBGL_lose_context` so it never counts against the
 * browser's context limit.
 */
export function probeWebGL2(env: GateEnv, caveat = true): boolean {
  const make = env.createCanvas;
  if (!make) return false;
  try {
    const canvas = make();
    const gl = canvas.getContext('webgl2', {
      failIfMajorPerformanceCaveat: caveat,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
    }) as ProbeContext | null;
    if (!gl) return false;
    try {
      (gl.getExtension('WEBGL_lose_context') as LoseContextExt)?.loseContext();
    } catch {
      // Released when garbage collected.
    }
    return true;
  } catch {
    return false;
  }
}

/** The whole gate: cheap signals first, the WebGL probe only if they pass. */
export function gateStage(
  env: GateEnv,
  opts: { crashFlag: boolean; override?: StageOverride },
): GateMode {
  const override = opts.override ?? null;
  if (override === 'flat') return 'flat';
  const cheap = readCheapSignals(env, opts.crashFlag);
  if (refuses3d(cheap) || (!override && !cheapAllows3d(cheap)))
    return decideStageMode({ ...cheap, webgl2: null }, override);
  // `?stage=3d|lite` skips the caveat flag so headless QA (SwiftShader) runs.
  const webgl2 = probeWebGL2(env, override === null);
  return decideStageMode({ ...cheap, webgl2 }, override);
}

/** The real browser environment (client only). */
export function browserGateEnv(): GateEnv {
  if (typeof window === 'undefined') return {};
  return {
    navigator: window.navigator as unknown as NavigatorLike,
    matchMedia:
      typeof window.matchMedia === 'function'
        ? (q) => window.matchMedia(q)
        : null,
    createCanvas: () => document.createElement('canvas'),
  };
}

// ---------------------------------------------------------------------------
// Pre-paint predicate (plan section 6): the same cheap rules, as plain data
// plus one self-contained JS expression the inline loader script can embed.

export const STAGE_PREPAINT_RULES = Object.freeze({
  reducedMotionQuery: REDUCED_MOTION_QUERY,
  reducedDataQuery: REDUCED_DATA_QUERY,
  flatMaxDeviceMemory: FLAT_MAX_DEVICE_MEMORY,
  crashKey: STAGE_CRASH_KEY,
});

/**
 * A JS expression (no trailing semicolon) that evaluates to `true` when 3D is
 * predicted: not reduced motion, not save-data / reduced-data, not
 * `deviceMemory <= 2`, no crash flag. Anything that throws (storage, an
 * exotic `navigator`) makes it `false`, so the loader is skipped.
 */
export function stagePrepaintExpression(): string {
  const r = STAGE_PREPAINT_RULES;
  return (
    '(function(){try{' +
    'var w=window,n=w.navigator||{},m=w.matchMedia;' +
    `if(m&&(m(${JSON.stringify(r.reducedMotionQuery)}).matches||m(${JSON.stringify(r.reducedDataQuery)}).matches))return false;` +
    'if(n.connection&&n.connection.saveData===true)return false;' +
    `if(typeof n.deviceMemory==="number"&&n.deviceMemory<=${r.flatMaxDeviceMemory})return false;` +
    `if(w.sessionStorage.getItem(${JSON.stringify(r.crashKey)})!==null)return false;` +
    'return true}catch(e){return false}})()'
  );
}

// ---------------------------------------------------------------------------
// Frame-time watchdog (plan section 4): p90 of rAF intervals over a window.

export const WATCHDOG_WINDOW = 90;
export const WATCHDOG_P90_LIMIT_MS = 34;
/** Do not sample this long after an upload, a wake or a rebuild. */
export const WATCHDOG_SKIP_MS = 500;
/** Intervals above this are a stall or a throttled tab, not a slow GPU. */
const WATCHDOG_MAX_SAMPLE_MS = 1000;

export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

export interface FrameWatchdog {
  /** Feed one frame interval; returns true when the window is full and too slow. */
  sample(intervalMs: number, now: number): boolean;
  /** Skip samples until `now + WATCHDOG_SKIP_MS` (uploads, wake, rebuild). */
  hold(now: number): void;
  reset(): void;
}

export function createFrameWatchdog(
  opts: { window?: number; limitMs?: number; skipMs?: number } = {},
): FrameWatchdog {
  const size = opts.window ?? WATCHDOG_WINDOW;
  const limit = opts.limitMs ?? WATCHDOG_P90_LIMIT_MS;
  const skip = opts.skipMs ?? WATCHDOG_SKIP_MS;
  let buf: number[] = [];
  let holdUntil = -Infinity;
  return {
    sample(intervalMs, now) {
      if (now < holdUntil) return false;
      if (!(intervalMs > 0) || intervalMs > WATCHDOG_MAX_SAMPLE_MS)
        return false;
      buf.push(intervalMs);
      if (buf.length > size) buf.shift();
      if (buf.length < size) return false;
      if (percentile(buf, 0.9) <= limit) return false;
      buf = [];
      return true;
    },
    hold(now) {
      holdUntil = Math.max(holdUntil, now + skip);
    },
    reset() {
      buf = [];
      holdUntil = -Infinity;
    },
  };
}

/** Where a too-slow verdict takes the stage. */
export function stepDown(mode: '3d' | 'lite'): 'lite' | 'flat' {
  return mode === '3d' ? 'lite' : 'flat';
}
