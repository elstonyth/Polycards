/**
 * Pack stage: the focused pack's poses (plan-focus-ciao sections 2 to 5).
 * Pure: no DOM, no three.js, no clock, no React. Loaded with the focus chunk
 * and the runtime, never in the first load.
 *
 * One value drives everything: `focus` (F), the continuous stop position the
 * page scroll gives. 0 is the row (the rest carousel); k >= 1 rests on
 * `keys[k - 1]` (Front, Top Hits, Pull Odds, Buyback, Recent Pulls, Closing,
 * fewer for a capsule or a pack with no pull odds). Between two stops the pose
 * moves by power1InOut of the local progress, as Ciao's scene follows its
 * scroll through `power1.inOut` per section; the paging writes the scroll
 * with an ease-out cubic, so the pose in time is power1InOut(outCubic(t)).
 */
import type {
  FocusCtx,
  FocusKey,
  PoseBlock,
  SpotRect,
  StageLayout,
} from './contract';
import { SPIN_LOCK } from './stage-pose';
import { smoothstep } from './stage-spin-math';

const DEG = Math.PI / 180;

/** The tap into the Front stop, and the return to the row (Ciao's 1.5 s page). */
export const FOCUS_MS = 1500;
/** The active block fades before "All packs" jumps back to the Front stop. */
export const LEAVE_FADE_MS = 250;
/** A back uploaded after the pack reached its stop turns over this long. */
export const BACK_TURN_MS = 650;
/** Neighbours are gone by this focus value. */
export const NEIGHBOUR_FADE_END = 0.6;
/**
 * At rest on either face the extra yaw (pointer lean, idle sway) stays within
 * this, so the back rests well clear of the 155..165 degree glare band.
 */
export const FOCUS_REST_YAW_MAX = 5 * DEG;
/** Sold out: in focus the dim is lighter, so the facts stay legible. */
export const FOCUS_SOLD_OUT_DIM = 0.75;

/** Neighbours slide out by this fraction of the host width, sink and set back. */
const NEIGHBOUR_SLIDE_FX = 0.6;
const NEIGHBOUR_SINK_ART = 0.25;
const NEIGHBOUR_BACK_ART = 0.2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Ciao's section ease: power1.inOut. */
export function power1InOut(q: number): number {
  const x = clamp01(q);
  return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
}

/** The focus pose block: `PoseBlock` plus the panel-fraction offsets. */
export type FocusPoseBlock = PoseBlock & { fx: number; fy: number };

/** The segment F lies in: [k0, k0 + 1] and the eased local progress. */
function segment(f: number, n: number): { k0: number; t: number } {
  const x = Math.min(n, Math.max(0, f));
  const k0 = Math.min(n - 1, Math.floor(x));
  return { k0: Math.max(0, k0), t: power1InOut(x - Math.max(0, k0)) };
}

/** A key as a pose block for the focused pack (`d` slots off the track). */
function keyBlock(
  key: Readonly<FocusKey>,
  d: number,
  l: Readonly<StageLayout>,
  ctx: Readonly<FocusCtx>,
  soldOut: boolean,
): FocusPoseBlock {
  const { w, h } = ctx.panel;
  // A back stop before the back is on the GPU: the same place, front facing,
  // turning over when it arrives (BACK_TURN_MS, `backW`).
  const backW = ctx.backW ?? 1;
  const ry = key.face === 'back' ? key.ry - 180 * (1 - clamp01(backW)) : key.ry;
  return {
    dx: -d * l.step,
    dy: 0,
    z: 0,
    rotX: key.rx * DEG,
    rotY: ry * DEG,
    rotZ: key.rz * DEG,
    scale: (key.long * h) / (l.artH * (ctx.fit ?? 1)),
    dim: soldOut ? FOCUS_SOLD_OUT_DIM : 1,
    fx: w > 0 ? (key.cx * w - l.cx) / w : 0,
    fy: h > 0 ? (key.cy * h - l.cy) / h : 0,
  };
}

/**
 * Focus pose for pack i. `rest` is the rest-carousel block (the spin is held
 * at 0 in focus). The focused pack moves from its rest pose to the Front key
 * over F 0..1, then from key to key; neighbours slide off sideways and sink.
 * F <= 0 returns `rest` with zero offsets.
 */
export function focusPose(
  rest: Readonly<PoseBlock>,
  focus: number,
  _turn: number,
  i: number,
  track: number,
  l: Readonly<StageLayout>,
  _desktop: boolean,
  soldOut: boolean,
  ctx: Readonly<FocusCtx>,
): FocusPoseBlock {
  const f = Math.max(0, focus);
  if (!(f > 0) || ctx.keys.length === 0) return { ...rest, fx: 0, fy: 0 };
  const d = i - track;
  if (i === ctx.index) {
    const n = ctx.keys.length;
    const { k0, t } = segment(f, n);
    const b = keyBlock(ctx.keys[Math.max(0, k0 - 1)]!, d, l, ctx, soldOut);
    const a: FocusPoseBlock = k0 === 0 ? { ...rest, fx: 0, fy: 0 } : b;
    const to =
      k0 === 0
        ? b
        : keyBlock(ctx.keys[Math.min(n - 1, k0)]!, d, l, ctx, soldOut);
    return {
      dx: lerp(a.dx, to.dx, t) + 0,
      dy: lerp(a.dy, to.dy, t) + 0,
      z: lerp(a.z, to.z, t) + 0,
      rotX: lerp(a.rotX, to.rotX, t) + 0,
      rotY: lerp(a.rotY, to.rotY, t) + 0,
      rotZ: lerp(a.rotZ, to.rotZ, t) + 0,
      scale: lerp(a.scale, to.scale, t),
      dim: lerp(a.dim, to.dim, t),
      fx: lerp(a.fx, to.fx, t) + 0,
      fy: lerp(a.fy, to.fy, t) + 0,
    };
  }
  const side = i > ctx.index ? 1 : -1;
  const e = clamp01(f);
  return {
    ...rest,
    dy: rest.dy + NEIGHBOUR_SINK_ART * l.artH * e,
    z: rest.z - NEIGHBOUR_BACK_ART * l.artH * e,
    fx: side * NEIGHBOUR_SLIDE_FX * e,
    fy: 0,
  };
}

/**
 * The focused back's spotlight at F: `on` follows the keys (0 at front
 * stops, 1 at the two back stops) with the pose's progress, the rect slides
 * from the gold box to the buyback paragraph between the back stops, so the
 * lit window stays put while the pack moves under it. `on` is scaled by the
 * back's readiness.
 */
export function spotAt(
  focus: number,
  ctx: Readonly<FocusCtx>,
): { on: number; rect: SpotRect } {
  const keys = ctx.keys;
  const none = { on: 0, rect: { x0: 0, y0: 0, x1: 1, y1: 1 } };
  if (keys.length === 0 || !(focus > 0)) return none;
  const n = keys.length;
  const { k0, t } = segment(focus, n);
  const keyAt = (k: number) => (k <= 0 ? null : keys[Math.min(n, k) - 1]);
  const a = keyAt(k0);
  const b = keyAt(k0 + 1);
  const rectOf = (
    k: FocusKey | null | undefined,
    other: FocusKey | null | undefined,
  ) => k?.rect ?? other?.rect ?? none.rect;
  const ra = rectOf(a, b);
  const rb = rectOf(b, a);
  const on = lerp(a?.on ?? 0, b?.on ?? 0, t) * clamp01(ctx.backW ?? 1);
  return {
    on,
    rect: {
      x0: lerp(ra.x0, rb.x0, t),
      y0: lerp(ra.y0, rb.y0, t),
      x1: lerp(ra.x1, rb.x1, t),
      y1: lerp(ra.y1, rb.y1, t),
    },
  };
}

/** The text block shown at F: switches 20% into a move, either way (Ciao). */
export function blockAt(focus: number, n: number): number {
  return Math.min(n, Math.max(0, Math.floor(focus + 0.8)));
}

/** Spin and focus are exclusive (10.4): focus may start only below 0.02, target and value. */
export function canStartFocus(spin: number, spinTarget: number): boolean {
  return spin < SPIN_LOCK && spinTarget < SPIN_LOCK;
}

/** While focus > 0 the spin is held at 0 (10.4). */
export function spinWhileFocused(focus: number, spin: number): number {
  return focus > 0 ? 0 : spin;
}

/** A neighbour's fade-out over F 0..0.6; the focused pack stays 1. */
export function focusOpacity(f: number, isFocused: boolean): number {
  if (isFocused) return 1;
  return 1 - smoothstep(0, NEIGHBOUR_FADE_END, f);
}

/**
 * Clamps the extra yaw (pointer lean, idle sway) the caller adds on top of a
 * focused pack's pose, so it rests at most 5 degrees off its key.
 */
export function clampFocusExtraYaw(extra: number, focus: number): number {
  if (!(focus > 0)) return extra;
  const m = FOCUS_REST_YAW_MAX;
  return extra > m ? m : extra < -m ? -m : extra;
}
