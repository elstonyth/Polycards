/**
 * Pack stage animation layer: a small local
 * scheduler that replaces the `motion` library on the stage, so the stage's
 * first load no longer carries it. It provides exactly what the stage used:
 *
 * 1. A per-frame loop with an `update` step and a `render` step (render runs
 *    after every update, so DOM writes from value listeners land first, as
 *    with `motion`'s `frame.update` / `frame.render`).
 * 2. A cancellable tween on an observable number: a duration with a bezier
 *    (`linear`, `easeOut` or four control points), or a physical spring
 *    (stiffness, damping, mass, rest thresholds, initial velocity) with the
 *    same analytic solution and rest test as `motion`'s spring generator.
 *    Starting a tween on a value stops the one already running on it.
 * 3. An observable number with `get()`, `set()` and `on('change')`.
 *
 * Time is `performance.now()` read once at the start of each frame (as
 * `motion` does), so a page that freezes that clock freezes every animation.
 */
import { cubicBezier } from '@/components/loader/loader-timeline';

// --- observable numbers ------------------------------------------------------

export interface Observable<T = number> {
  get(): T;
  set(v: T): void;
  on(event: 'change', cb: (v: T) => void): () => void;
}

class Value implements Observable<number> {
  private v: number;
  private subs = new Set<(v: number) => void>();
  /** The tween running on this value, if any. */
  tween: Tween | null = null;
  constructor(v: number) {
    this.v = v;
  }
  get = () => this.v;
  set = (v: number) => {
    if (v === this.v) return;
    this.v = v;
    for (const cb of [...this.subs]) cb(v);
  };
  on = (_event: 'change', cb: (v: number) => void) => {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  };
}

export function observable(v: number): Observable<number> {
  return new Value(v);
}

// --- the frame loop ------------------------------------------------------------

export type FrameData = { timestamp: number; delta: number };
type FrameCallback = (data: FrameData) => void;

const steps = {
  update: new Map<FrameCallback, boolean>(),
  render: new Map<FrameCallback, boolean>(),
};
const tweens = new Set<Tween>();
const data: FrameData = { timestamp: 0, delta: 0 };
let scheduled = false;
let processing = false;

function wake() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(processFrame);
}

function runStep(step: Map<FrameCallback, boolean>) {
  // Callbacks added while a step runs wait for the next frame.
  const now = [...step];
  for (const [cb, keep] of now) if (!keep) step.delete(cb);
  for (const [cb] of now) cb(data);
}

function processFrame() {
  scheduled = false;
  const t = performance.now();
  data.delta = data.timestamp ? Math.min(t - data.timestamp, 1000) : 1000 / 60;
  data.timestamp = t;
  processing = true;
  // Tweens move their values first: their listeners write the DOM (update).
  for (const tw of [...tweens]) tw.step(t);
  runStep(steps.update);
  runStep(steps.render);
  processing = false;
  if (tweens.size > 0 || steps.update.size > 0 || steps.render.size > 0) wake();
}

function schedule(step: Map<FrameCallback, boolean>) {
  return (cb: FrameCallback, keepAlive = false) => {
    if (!step.has(cb) || keepAlive) step.set(cb, keepAlive);
    wake();
    return cb;
  };
}

export const frame = {
  update: schedule(steps.update),
  render: schedule(steps.render),
};

export function cancelFrame(cb: FrameCallback): void {
  steps.update.delete(cb);
  steps.render.delete(cb);
}

/** The time a tween started now counts from: this frame's, or the clock's. */
const now = () => (processing ? data.timestamp : performance.now());

// --- tweens ----------------------------------------------------------------------

export type Bezier = readonly [number, number, number, number];
export type Ease = 'linear' | 'easeOut' | Bezier;

export type TweenOptions = {
  /** Seconds. */
  duration: number;
  ease?: Ease;
  onComplete?: () => void;
};

export type SpringOptions = {
  type: 'spring';
  stiffness: number;
  damping: number;
  mass?: number;
  restDelta?: number;
  restSpeed?: number;
  /** Units per second, positive toward the target's direction of increase. */
  velocity?: number;
  onComplete?: () => void;
};

export type AnimationControls = { stop(): void };

const EASE_OUT = cubicBezier(0, 0, 0.58, 1);
const easeFn = (e: Ease | undefined): ((p: number) => number) =>
  e === undefined || e === 'linear'
    ? (p) => p
    : e === 'easeOut'
      ? EASE_OUT
      : cubicBezier(e[0], e[1], e[2], e[3]);

/** One running animation: returns its value and whether it is done at time t (ms since start). */
type Generator = (t: number) => { value: number; done: boolean };

/**
 * `motion`'s physical spring, underdamped, critically damped or overdamped,
 * with its rest test (speed and distance under the thresholds; the granular
 * defaults when the distance is under 5).
 */
export function springGenerator(
  from: number,
  to: number,
  o: Omit<SpringOptions, 'type' | 'onComplete'>,
): Generator {
  const mass = o.mass ?? 1;
  const delta = to - from;
  const granular = Math.abs(delta) < 5;
  const restSpeed = o.restSpeed || (granular ? 0.01 : 2);
  const restDelta = o.restDelta || (granular ? 0.005 : 0.5);
  // Units per ms, with motion's sign convention.
  const v0 = -(o.velocity ?? 0) / 1000;
  const ratio = o.damping / (2 * Math.sqrt(o.stiffness * mass));
  const w0 = Math.sqrt(o.stiffness / mass) / 1000;
  const decay = ratio * w0;
  let position: (t: number) => number;
  let speed: (t: number) => number; // units per ms
  if (ratio < 1) {
    const wd = w0 * Math.sqrt(1 - ratio * ratio);
    const A = (v0 + decay * delta) / wd;
    const sinC = decay * A + delta * wd;
    const cosC = decay * delta - A * wd;
    position = (t) => {
      const env = Math.exp(-decay * t);
      return to - env * (A * Math.sin(wd * t) + delta * Math.cos(wd * t));
    };
    speed = (t) =>
      Math.exp(-decay * t) *
      (sinC * Math.sin(wd * t) + cosC * Math.cos(wd * t));
  } else if (ratio === 1) {
    const C = v0 + w0 * delta;
    position = (t) => to - Math.exp(-w0 * t) * (delta + C * t);
    speed = (t) => Math.exp(-w0 * t) * (w0 * C * t - v0);
  } else {
    const wd = w0 * Math.sqrt(ratio * ratio - 1);
    const slow = decay - wd;
    const fast = decay + wd;
    const limit = wd < 1 ? Infinity : 300 / wd;
    const decayAt = (rate: number, t: number) =>
      Math.exp(t > limit ? (decay - rate) * limit - decay * t : -rate * t);
    const P = (v0 + decay * delta) / wd;
    const S = (delta + P) / 2;
    const F = (delta - P) / 2;
    position = (t) => to - S * decayAt(slow, t) - F * decayAt(fast, t);
    speed = (t) => slow * S * decayAt(slow, t) + fast * F * decayAt(fast, t);
  }
  return (t) => {
    const value = position(t);
    const done =
      Math.abs(speed(t) * 1000) <= restSpeed &&
      Math.abs(to - value) <= restDelta;
    return { value: done ? to : value, done };
  };
}

export function tweenGenerator(
  from: number,
  to: number,
  o: Omit<TweenOptions, 'onComplete'>,
): Generator {
  const ms = Math.max(0, o.duration * 1000);
  const ease = easeFn(o.ease);
  return (t) => {
    if (ms === 0 || t >= ms) return { value: to, done: true };
    const p = Math.max(0, t / ms);
    return { value: from + (to - from) * ease(p), done: false };
  };
}

class Tween {
  private start: number;
  private stopped = false;
  constructor(
    private value: Value,
    private gen: Generator,
    private onComplete?: () => void,
  ) {
    this.start = now();
  }
  step(t: number) {
    if (this.stopped) return;
    const { value, done } = this.gen(Math.max(0, t - this.start));
    this.value.set(value);
    if (done) {
      this.finish();
      this.onComplete?.();
    }
  }
  private finish() {
    this.stopped = true;
    tweens.delete(this);
    if (this.value.tween === this) this.value.tween = null;
  }
  stop = () => {
    if (!this.stopped) this.finish();
  };
}

/**
 * Animates `v` from its current value to `to`. A tween already running on
 * `v` is stopped first. The value moves from the next frame on.
 */
export function animate(
  v: Observable<number>,
  to: number,
  o: TweenOptions | SpringOptions,
): AnimationControls {
  const value = v as Value;
  value.tween?.stop();
  const from = value.get();
  const gen =
    'type' in o ? springGenerator(from, to, o) : tweenGenerator(from, to, o);
  const tw = new Tween(value, gen, o.onComplete);
  value.tween = tw;
  tweens.add(tw);
  wake();
  return { stop: tw.stop };
}
