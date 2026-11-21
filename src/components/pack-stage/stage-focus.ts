/**
 * Pack stage: the focused pack's poses.
 * Pure: no DOM, no three.js, no clock, no React. Loaded with the focus chunk
 * and the runtime, never in the first load.
 *
 * One value drives everything: `focus` (F), the continuous stop position the
 * page scroll gives. 0 is the row (the rest carousel); k >= 1 rests on
 * `keys[k - 1]` (Front, Top Hits, Pull Odds, Buyback, Recent Pulls, Closing,
 * fewer for a capsule or a pack with no pull odds). Between two stops the pose
 * moves by power1InOut of the local progress, the scene follows the
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
import { smoothstep } from './stage-spin-math';

const DEG = Math.PI / 180;

/** The active block fades before "All packs" jumps back to the Front stop. */
export const LEAVE_FADE_MS = 250;
/** A back uploaded after the pack reached its stop turns over this long. */
export const BACK_TURN_MS = 650;
/**
 * The neighbours leave WITH the tap, over this share of its time (sliding
 * out, sinking and setting back as they fade).
 */
export const NEIGHBOUR_OUT_SHARE = 0.4;
/**
 * On the leave they come back between these fractions of its time. The
 * pack's pose follows power1InOut of the focus, so it has made 90% of its
 * change of size by about 0.39 of the leave's time and lands (99%) by about
 * 0.59. They start once the first 250 ms have passed (a stop's text may
 * still be fading then) and are fully back just after the pack lands; their
 * slide leads their fade (focusPose), so they are on screen by the 90% pose.
 */
export const NEIGHBOUR_BACK_FROM = 1 / 6;
export const NEIGHBOUR_BACK_TO = 0.64;

/**
 * The neighbours' progress at focus f: 0 in the row, 1 gone. The tap and the
 * leave are ease-out cubic moves, so their time fraction comes back from f:
 * the tap's t = 1 - cbrt(1 - f), the leave's time left = cbrt(f).
 */
export function neighbourOut(f: number, leaving = false): number {
  const x = clamp01(f);
  if (x >= 1) return 1;
  if (leaving)
    return clamp01(
      (Math.cbrt(x) - (1 - NEIGHBOUR_BACK_TO)) /
        (NEIGHBOUR_BACK_TO - NEIGHBOUR_BACK_FROM),
    );
  return clamp01((1 - Math.cbrt(1 - x)) / NEIGHBOUR_OUT_SHARE);
}
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

/** The section ease: power1.inOut. */
export function power1InOut(q: number): number {
  const x = clamp01(q);
  return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
}

/** The focus pose block: `PoseBlock` plus the panel-fraction offsets. */
export type FocusPoseBlock = PoseBlock & { fx: number; fy: number };

/** The segment F lies in: [k0, k0 + 1], the local progress and its ease. */
function segment(f: number, n: number): { k0: number; t: number; x: number } {
  const v = Math.min(n, Math.max(0, f));
  const k0 = Math.max(0, Math.min(n - 1, Math.floor(v)));
  const x = v - k0;
  return { k0, t: power1InOut(x), x };
}

/**
 * A move that turns the pack over is staged as a real pack is handled: the
 * turn leads and the lie-down follows (back to the front: it stands up
 * first, then turns). Each takes this share of the move, overlapping.
 */
export const TURN_SHARE = 0.65;

/** The turn's and the roll's progress in a move between faces. */
export function turnPhases(
  x: number,
  toBack: boolean,
): { turn: number; roll: number } {
  const lead = power1InOut(x / TURN_SHARE);
  const follow = power1InOut((x - (1 - TURN_SHARE)) / TURN_SHARE);
  return toBack ? { turn: lead, roll: follow } : { turn: follow, roll: lead };
}

/**
 * Desktop: the free lane of the panel for a back lying across it, in panel
 * width fractions, from the stop text's column (focus.module.css `.over
 * .block`: left 10.2% + width 33.4%) to the stop icons (`.icons`: left
 * 1334/1440), with a gap in px on each side.
 */
export const DESKTOP_BACK_LANE = { left: 0.436, right: 1334 / 1440, gap: 24 };

/**
 * A desktop back key (lying down, rz 90: its long side runs across) moved,
 * and shrunk only when it is longer than the lane, so it stays between the
 * text and the icons at any panel aspect.
 */
export function fitBackKey(
  key: Readonly<{ cx: number; long: number }>,
  w: number,
  h: number,
): { cx: number; long: number } {
  const left = DESKTOP_BACK_LANE.left * w + DESKTOP_BACK_LANE.gap;
  const right = DESKTOP_BACK_LANE.right * w - DESKTOP_BACK_LANE.gap;
  if (!(w > 0 && h > 0 && right > left)) return { cx: key.cx, long: key.long };
  const len = Math.min(key.long * h, right - left);
  const cx = Math.min(right - len / 2, Math.max(left + len / 2, key.cx * w));
  return { cx: cx / w, long: len / h };
}

/**
 * Phone: the px under the pack kept for the Front text and the buy dock (and
 * Closing's title and buttons). The reference phone's pose (390 wide) ends
 * there; narrower phones wrap their text into more lines, so they keep more.
 */
export function phoneTextReserve(w: number): number {
  return 250 + Math.min(30, Math.max(0, 390 - w) * 0.6);
}

/**
 * A phone Front or Closing key (upright: its long side runs down) shrunk from
 * its foot, top kept, so it ends above the text under it on short phones.
 */
export function fitPhoneTextKey(
  key: Readonly<{ cy: number; long: number }>,
  w: number,
  h: number,
): { cy: number; long: number } {
  const top = (key.cy - key.long / 2) * h;
  const foot = h - phoneTextReserve(w);
  const len = key.long * h;
  if (!(h > 0) || top + len <= foot || foot <= top)
    return { cy: key.cy, long: key.long };
  return { cy: (top + (foot - top) / 2) / h, long: (foot - top) / h };
}

/**
 * Desktop: the stops keep to a box at most this wide (CSS px), centred in the
 * panel, so on very wide views (3440, a 4K screen at ratio 1) the text column
 * and the pack stay together. focus.module.css `.over` caps at the same width.
 */
export const DESKTOP_MAX_W = 2560;

/** A key as a pose block for the focused pack (`d` slots off the track). */
function keyBlock(
  key: Readonly<FocusKey>,
  d: number,
  l: Readonly<StageLayout>,
  ctx: Readonly<FocusCtx>,
  soldOut: boolean,
  desktop: boolean,
): FocusPoseBlock {
  const { w, h } = ctx.panel;
  // desktop keys are fractions of the centred box (the whole panel up to its cap)
  const bw = desktop ? Math.min(w, DESKTOP_MAX_W) : w;
  const x0 = (w - bw) / 2;
  const { cx, long, cy } =
    desktop && key.face === 'back'
      ? { ...key, ...fitBackKey(key, bw, h) }
      : !desktop && (key.kind === 'front' || key.kind === 'closing')
        ? { ...key, ...fitPhoneTextKey(key, w, h) }
        : key;
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
    scale: (long * h) / (l.artH * (ctx.fit ?? 1)),
    dim: soldOut ? FOCUS_SOLD_OUT_DIM : 1,
    fx: w > 0 ? (x0 + cx * bw - l.cx) / w : 0,
    fy: h > 0 ? (cy * h - l.cy) / h : 0,
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
  desktop: boolean,
  soldOut: boolean,
  ctx: Readonly<FocusCtx>,
): FocusPoseBlock {
  const f = Math.max(0, focus);
  if (!(f > 0) || ctx.keys.length === 0) return { ...rest, fx: 0, fy: 0 };
  const d = i - track;
  if (i === ctx.index) {
    const n = ctx.keys.length;
    const { k0, t, x } = segment(f, n);
    const kb = ctx.keys[Math.max(0, k0 - 1)]!;
    const b = keyBlock(kb, d, l, ctx, soldOut, desktop);
    const a: FocusPoseBlock = k0 === 0 ? { ...rest, fx: 0, fy: 0 } : b;
    const kt = ctx.keys[Math.min(n - 1, k0)]!;
    const to = k0 === 0 ? b : keyBlock(kt, d, l, ctx, soldOut, desktop);
    // turning over: the turn and the lie-down are staged; otherwise every
    // part of the pose follows the same ease
    let ty = t;
    let tz = t;
    if (k0 > 0 && kb.face !== kt.face) {
      const ph = turnPhases(x, kt.face === 'back');
      ty = ph.turn;
      tz = ph.roll;
    }
    return {
      dx: lerp(a.dx, to.dx, t) + 0,
      dy: lerp(a.dy, to.dy, t) + 0,
      z: lerp(a.z, to.z, t) + 0,
      rotX: lerp(a.rotX, to.rotX, t) + 0,
      rotY: lerp(a.rotY, to.rotY, ty) + 0,
      rotZ: lerp(a.rotZ, to.rotZ, tz) + 0,
      scale: lerp(a.scale, to.scale, t),
      dim: lerp(a.dim, to.dim, t),
      fx: lerp(a.fx, to.fx, t) + 0,
      fy: lerp(a.fy, to.fy, t) + 0,
    };
  }
  const side = i > ctx.index ? 1 : -1;
  // leaving, the slide and sink lead the fade: most of the way home while
  // they are still fading in
  const s = smoothstep(0, 1, neighbourOut(f, ctx.leaving));
  const e = ctx.leaving ? s * s : s;
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

/** The text block shown at F: switches 20% into a move, either way. */
export function blockAt(focus: number, n: number): number {
  return Math.min(n, Math.max(0, Math.floor(focus + 0.8)));
}

/** A neighbour's fade, in step with its slide (neighbourOut); the focused pack stays 1. */
export function focusOpacity(
  f: number,
  isFocused: boolean,
  ctx?: Readonly<Pick<FocusCtx, 'leaving'>> | null,
): number {
  if (isFocused) return 1;
  return 1 - smoothstep(0, 1, neighbourOut(f, !!ctx?.leaving));
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
