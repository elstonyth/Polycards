/**
 * Pack stage: the scroll spin section's pose. Pure: no DOM, no three.js, no clock, no React.
 *
 * `spin` (`s`) runs 0..1 through the pinned section. Three phases:
 * - gather, s 0..0.15: the carousel closes into one tilted row (smoothstep);
 * - travel and turn, s 0.15..0.85: the row travels left through every pack
 *   once (wrapping) while each pack turns about its own axis, neighbours
 *   `K` apart, plus one extra full turn (power1.inOut);
 * - hold, s 0.85..1: the row is back in its starting order, fronts facing.
 *
 * `spinPose` replaces ONLY the rest-carousel block of `poseAt` (lerp by the
 * gather weight); float-in, swap, pointer and idle terms are added on top by
 * the caller (`stage-pose-step2.ts` shows the composition).
 *
 * First-load JS: this module is NOT imported by the pose module. The runtime
 * chunk imports it statically; the CSS tiles import it at idle and pass it as
 * `ctx.spinPose`.
 */
import type { StageLayout } from './contract';
import type {
  PoseBlock,
  SpinCtx,
  SpinPanel,
  SpinPoseBlock,
  SpinPoseFn,
  StageState,
} from './contract';
import { slotOpacity } from './stage-pose';
import { SPIN_LOCK } from './stage-pose';
import { SPIN_GATHER, clamp01, smoothstep } from './stage-spin-math';
import { CAPSULE_LIMITS } from './stage-capsule-lean';

export { SPIN_LOCK, smoothstep };

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;

export type SpinConfig = {
  /** Row scale (one size for every pack). */
  S: number;
  /** Row step in pack widths at scale S. */
  GAP: number;
  /** Row roll, radians (negative: rising to the right). */
  ROLL: number;
  /** Packs drawn in the row: |d'| < REACH + 1. */
  REACH: number;
  /** Fewer packs than this: no travel, they spin in place (a wrapped row would show a pack twice). */
  MIN_TRAVEL_N: number;
};

// S tuned 2026-11-20 against measured reference frames: the packshot cans
// stand about 340 CSS px on a 1440x900 desktop and 285-300 on a 390x844
// phone; at 0.62 / 0.55 ours were 218 / 308. Now about 282 / 336.
export const SPIN_PHONE: Readonly<SpinConfig> = Object.freeze({
  S: 0.8,
  GAP: 1.15,
  ROLL: -7 * DEG,
  REACH: 1,
  MIN_TRAVEL_N: 4,
});

export const SPIN_DESKTOP: Readonly<SpinConfig> = Object.freeze({
  S: 0.6,
  GAP: 1.5,
  ROLL: -9 * DEG,
  REACH: 2,
  MIN_TRAVEL_N: 6,
});

export function spinConfig(desktop: boolean): Readonly<SpinConfig> {
  return desktop ? SPIN_DESKTOP : SPIN_PHONE;
}

/** End of the gather. */
export const GATHER = SPIN_GATHER;
/** Start of the hold. */
export const HOLD = 0.85;
/** Own-axis yaw between neighbours, radians per slot (34 degrees). */
export const K = 0.6;
/** Pitch ramp: tops toward the viewer, more to the right. */
export const PITCH0 = 0.1;
export const PITCH_K = 0.035;
/** Pitch never above +5 degrees in any spin pose (positive = top away). */
export const PITCH_MAX = 0.087;
/** Height wave along the row, in art heights, and its phase per slot. */
export const WAVE_A = 0.05;
export const WAVE_W = 1.1;
/** Row arcs back by this many art heights per slot. */
export const ARC = 0.1;
/** Pack aspect used when the layout gives no `artW` (step 1 CSS: --art-w = 0.54 art heights). */
export const DEFAULT_ART_ASPECT = 0.54;
/** `data-spinning` hysteresis around SPIN_LOCK. */
const SPIN_LOCK_HYSTERESIS = 0.005;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Gather weight g: 0 at s = 0, 1 from s = 0.15. */
export function spinGather(s: number): number {
  return smoothstep(0, GATHER, s);
}

/** Eased travel/turn progress `ce` (power1.inOut over 0.15..0.85). */
export function spinPhase(s: number): number {
  const c = clamp01((s - GATHER) / (HOLD - GATHER));
  return 0.5 - 0.5 * Math.cos(Math.PI * c);
}

/** True when this many packs travel (wrap) instead of spinning in place. */
export function spinTravels(count: number, desktop: boolean): boolean {
  return count >= spinConfig(desktop).MIN_TRAVEL_N;
}

/** Travel T in packs (0 when the row spins in place). */
export function spinTravel(s: number, count: number, desktop: boolean): number {
  return spinTravels(count, desktop) ? count * spinPhase(s) : 0;
}

/** Wraps x into [-n/2, n/2). */
export function wrapRow(x: number, n: number): number {
  if (n <= 0) return x;
  const h = n / 2;
  const r = (((x + h) % n) + n) % n;
  return r - h + 0; // +0 normalises -0
}

/** The pack's row position d' during the spin. */
export function spinRowPosition(
  s: number,
  i: number,
  track: number,
  count: number,
  desktop: boolean,
): number {
  const d = i - track;
  if (!spinTravels(count, desktop)) return d;
  return wrapRow(d - spinTravel(s, count, desktop), count);
}

/**
 * The continuous centre of the wrapped row in pack-index space (track + T),
 * for residency: pass `wrappedIndex(i, centre, n)` as each pack's index and
 * `centre` as the track (fronts keep today's residency on the wrapped spin
 * centre).
 */
export function spinCentre(
  s: number,
  track: number,
  count: number,
  desktop: boolean,
): number {
  return track + spinTravel(s, count, desktop);
}

/** The integer index of pack i nearest the wrapped centre: i + k*n, within [-n/2, n/2) of it. */
export function wrappedIndex(i: number, centre: number, count: number): number {
  return centre + wrapRow(i - centre, count);
}

/**
 * The glare pass band. Periodic, odd, monotone, piecewise linear: the
 * output bands 150..170 and 190..210 degrees (and every 360-degree copy) each
 * come from only 5 degrees of input (slope 4); the other 320 output degrees
 * from the other 350 input degrees. passBand(0) = 0, passBand(2 pi) = 2 pi.
 */
export const PASS_BAND = Object.freeze({
  /** Output band edges, degrees. */
  lo: 150,
  hi: 170,
  /** Input degrees that map into one band. */
  input: 5,
});
const PB_SLOPE = 320 / 350;
const PB_IN_A = PASS_BAND.lo / PB_SLOPE; // 164.0625
const PB_IN_B = PB_IN_A + PASS_BAND.input; // 169.0625
const PB_TAIL_SLOPE = (180 - PASS_BAND.hi) / (180 - PB_IN_B);

function passBandHalfDeg(x: number): number {
  if (x <= PB_IN_A) return x * PB_SLOPE;
  if (x <= PB_IN_B) return PASS_BAND.lo + (x - PB_IN_A) * 4;
  return PASS_BAND.hi + (x - PB_IN_B) * PB_TAIL_SLOPE;
}

export function passBand(phi: number): number {
  const deg = phi / DEG;
  const m = ((deg % 360) + 360) % 360;
  const base = deg - m;
  const out = m <= 180 ? passBandHalfDeg(m) : 360 - passBandHalfDeg(360 - m);
  return (base + out) * DEG + 0;
}

/** Row step in host px: GAP * S * artW. */
export function spinRowStep(
  l: Readonly<StageLayout>,
  desktop: boolean,
): number {
  const c = spinConfig(desktop);
  const artW = l.artW && l.artW > 0 ? l.artW : l.artH * DEFAULT_ART_ASPECT;
  return c.GAP * c.S * artW;
}

/**
 * The spin's pose for pack i. `rest` is `poseAt`'s rest-carousel block
 * (before float-in, swap, pointer and idle). s <= 0 returns `rest` unchanged.
 */
export const spinPose: SpinPoseFn = (rest, st, i, l, desktop, ctx) => {
  const s = clamp01(st.spin);
  if (!(s > 0)) return { ...rest };
  const n = ctx.count;
  const c = spinConfig(desktop);
  const g = spinGather(s);
  const ce = spinPhase(s);
  const d = i - st.track;
  const travels = spinTravels(n, desktop);
  const dp = travels ? wrapRow(d - n * ce, n) : d;
  const w = spinRowStep(l, desktop);

  const x = dp * w;
  const row: PoseBlock = {
    dx: x - d * l.step,
    dy:
      -x * Math.tan(Math.abs(c.ROLL)) + WAVE_A * l.artH * Math.sin(WAVE_W * dp),
    z: -ARC * l.artH * Math.abs(dp),
    rotX: Math.min(PITCH_MAX, -(PITCH0 + PITCH_K * dp)),
    rotY: 0,
    rotZ: c.ROLL,
    scale: c.S,
    // the row drops the desktop distance dim; only sold out stays dimmed
    dim: ctx.soldOut ? SOLD_OUT_DIM : 1,
  };
  const theta = passBand(-K * dp + TAU * ce);
  const turn = clamp01(ctx.turn);
  row.rotY = turn * theta + (1 - turn) * ctx.lean * Math.sin(theta);

  // A pack that wraps to the other side of the row (only ever one that is
  // invisible at rest, |d| > n/2) takes its row slot outright and fades in
  // there (spinOpacity); lerping it from its rest slot would fly it across.
  const wrapped = travels && Math.abs(wrapRow(d, n) - d) > 1e-9;
  if (wrapped) return applyExit(normalise(row), d, l, ctx);

  return applyExit(
    normalise({
      dx: lerp(rest.dx, row.dx, g),
      dy: lerp(rest.dy, row.dy, g),
      z: lerp(rest.z, row.z, g),
      rotX: lerp(rest.rotX, row.rotX, g),
      rotY: lerp(rest.rotY, row.rotY, g),
      rotZ: lerp(rest.rotZ, row.rotZ, g),
      scale: lerp(rest.scale, row.scale, g),
      dim: lerp(rest.dim, row.dim, g),
    }),
    d,
    l,
    ctx,
  );
};

// --- The packshot lineup row and its exit ---------------------------------

/**
 * The quadratic in-out (`power1.inOut`), the ease of every section tween:
 * e(t) = t < 0.5 ? 2t^2 : 1 - (2 - 2t)^2 / 2.
 */
export function quadInOut(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 2 * x * x : 1 - ((2 - 2 * x) * (2 - 2 * x)) / 2;
}

/** A lineup camera keyframe: position, Euler XYZ rotation (rad), fov (deg), row spacing, key light. */
export type LineupCamera = {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  fov: number;
  spacing: number;
  light: number;
};

/** Keyframe at the top of the lineup section: the tilted packshot row. */
export const LINEUP_REST_CAMERA: Readonly<LineupCamera> = Object.freeze({
  x: -3,
  y: -3.5,
  z: 20,
  rx: 10 * DEG,
  ry: -9 * DEG,
  rz: -10 * DEG,
  fov: 30,
  spacing: 0.47,
  light: 10,
});

/** Keyframe at the top of the exit section: the camera has dropped, come closer, levelled; light out. */
export const LINEUP_EXIT_CAMERA: Readonly<LineupCamera> = Object.freeze({
  x: 0,
  y: -5.5,
  z: 10,
  rx: 0,
  ry: 0,
  rz: 0,
  fov: 30,
  spacing: 0.6,
  light: 0,
});

/** The lineup's row step in its units, the cans' depth in the packshot, and the swirl pitch ramp. */
export const LINEUP_ROW = Object.freeze({
  step: 3.5,
  canZ: -0.4,
  pitchPerUnit: 0.06,
  pitchBias: 0.2,
  /** r = clamp(1440 / viewport width, 1, 2.4): the phone's ramp is 2.4x steeper. */
  ratioRefWidth: 1440,
  ratioMax: 2.4,
  /**
   * A can's height in the lineup's scene units, measured off the reference
   * frames at rest: about 340 CSS px on the 900 px desktop viewport at depth
   * 20.5 under fov 30 (4.15 units; the phone's 285-300 px reads 3.7-3.9 with
   * the steeper ramp shortening it). Our pack takes this height, so it stands
   * as tall on screen as the reference can.
   */
  canWorldH: 4.1,
  /** Our pack width over the row step: "nearly touching" (their cans: about 125 px wide at a 133 px step). */
  fill: 0.92,
  /**
   * Row slots drawn either side of the centre in the packshot (copies fill
   * them when the set is short): desktop about 4 across each half at the new
   * size, more on the receding right; phone 1 plus a cut one each side.
   */
  reachDesktop: 6,
  reachPhone: 2,
  /**
   * Light. The packshot raises the environment to x2 (tint 2) while its key
   * spots run at 10, so its cans read bright; ours are lit by the environment
   * only, so the formed row lifts by `restLight`. On the exit the spots go
   * 10 -> 0 but the environment stays, and the reference frames show the cans
   * barely darker as they leave: the row ends at `exitLight` of its rest.
   */
  restLight: 1.12,
  exitLight: 0.85,
  /** Capsules (owner, 2026-11-20): seen tipping away at most 15 deg, toward the viewer at most 25. */
  capsuleTipAway: CAPSULE_LIMITS.tipAway,
  capsuleTipToward: CAPSULE_LIMITS.tipToward,
});

/** The light multiplier for camera `cam` (rest light, falling to the exit light as the spots go out). */
function lineupLight(cam: Readonly<LineupCamera>): number {
  const out = 1 - cam.light / LINEUP_REST_CAMERA.light;
  return LINEUP_ROW.restLight * (1 - (1 - LINEUP_ROW.exitLight) * out);
}

/** World step between our packs in lineup units at the packshot (for an art aspect w/h). */
export function lineupPackStep(artAspect: number): number {
  return (LINEUP_ROW.canWorldH * artAspect) / LINEUP_ROW.fill;
}

/** Exit length after the pin, in panel heights (one section, 1.25 viewports). */
export const LINEUP_EXIT_PANELS = 1.25;

export function lineupCameraAt(exit: number): LineupCamera {
  const e = quadInOut(exit);
  const a = LINEUP_REST_CAMERA;
  const b = LINEUP_EXIT_CAMERA;
  return {
    x: lerp(a.x, b.x, e),
    y: lerp(a.y, b.y, e),
    z: lerp(a.z, b.z, e),
    rx: lerp(a.rx, b.rx, e),
    ry: lerp(a.ry, b.ry, e),
    rz: lerp(a.rz, b.rz, e),
    fov: lerp(a.fov, b.fov, e),
    spacing: lerp(a.spacing, b.spacing, e),
    light: lerp(a.light, b.light, e),
  };
}

type M3 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
const mul = (a: M3, b: M3): M3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
  a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
  a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
  a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
  a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
  a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
  a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
const rotXm = (t: number): M3 => [
  1,
  0,
  0,
  0,
  Math.cos(t),
  -Math.sin(t),
  0,
  Math.sin(t),
  Math.cos(t),
];
const rotYm = (t: number): M3 => [
  Math.cos(t),
  0,
  Math.sin(t),
  0,
  1,
  0,
  -Math.sin(t),
  0,
  Math.cos(t),
];
const rotZm = (t: number): M3 => [
  Math.cos(t),
  -Math.sin(t),
  0,
  Math.sin(t),
  Math.cos(t),
  0,
  0,
  0,
  1,
];
const transpose = (m: M3): M3 => [
  m[0],
  m[3],
  m[6],
  m[1],
  m[4],
  m[7],
  m[2],
  m[5],
  m[8],
];

/** One pack of the lineup row seen through a lineup camera (three.js axes: y up, camera looks down -z). */
export type LineupView = {
  /** Screen position in half-heights from the centre (y up): px = s * panelH / 2. */
  sx: number;
  sy: number;
  /** Distance along the view axis. */
  depth: number;
  /** View-space orientation as three.js Euler 'ZYX' angles. */
  ex: number;
  ey: number;
  ez: number;
};

export function lineupRatio(panelW: number): number {
  return Math.min(
    LINEUP_ROW.ratioMax,
    Math.max(1, LINEUP_ROW.ratioRefWidth / Math.max(1, panelW)),
  );
}

/** The pack at row position dp (in packs) through camera `cam`, with the swirl pitch ramp for ratio r. */
export function lineupView(
  dp: number,
  cam: Readonly<LineupCamera>,
  r: number,
  o: { spacingScale?: number; capsule?: boolean } = {},
): LineupView {
  // x in the lineup's row units (the ramp keeps its per-pack numbers); the world
  // step widens by `spacingScale` because a pack is wider than a can
  const x = dp * LINEUP_ROW.step;
  const px = x * cam.spacing * (o.spacingScale ?? 1) - cam.x;
  const py = 0 - cam.y;
  const pz = LINEUP_ROW.canZ - cam.z;
  // three's Euler 'XYZ': R = Rx * Ry * Rz
  const rc = mul(mul(rotXm(cam.rx), rotYm(cam.ry)), rotZm(cam.rz));
  const rt = transpose(rc);
  const vx = rt[0] * px + rt[1] * py + rt[2] * pz;
  const vy = rt[3] * px + rt[4] * py + rt[5] * pz;
  const vz = rt[6] * px + rt[7] * py + rt[8] * pz;
  // positive pitch tips the top toward the viewer: cans to the right show their tops
  let pitch = x * LINEUP_ROW.pitchPerUnit * r + LINEUP_ROW.pitchBias;
  if (o.capsule) {
    // as SEEN: the camera's own pitch tips everything away by cam.rx
    const lo = cam.rx - LINEUP_ROW.capsuleTipAway;
    const hi = cam.rx + LINEUP_ROW.capsuleTipToward;
    pitch = Math.max(lo, Math.min(hi, pitch));
  }
  const m = mul(rt, rotXm(pitch));
  // three's Euler.setFromRotationMatrix, order 'ZYX'
  const m31 = m[6];
  const ey = Math.asin(-Math.max(-1, Math.min(1, m31)));
  let ex: number;
  let ez: number;
  if (Math.abs(m31) < 0.9999999) {
    ex = Math.atan2(m[7], m[8]);
    ez = Math.atan2(m[3], m[0]);
  } else {
    ex = 0;
    ez = Math.atan2(-m[1], m[4]);
  }
  const t = Math.tan(((cam.fov / 2) * Math.PI) / 180);
  const depth = -vz;
  return { sx: vx / depth / t, sy: vy / depth / t, depth, ex, ey, ez };
}

const DEFAULT_PANEL = { w: 390, h: 716, anchorY: 0.46 };

/** The lineup row's pose for a pack at row position dp, as our pose (fx / fy carry the position). */
function lineupRowBlock(
  dp: number,
  d: number,
  l: Readonly<StageLayout>,
  panel: Readonly<SpinPanel>,
  cam: Readonly<LineupCamera>,
  soldOut: boolean,
  capsule: boolean,
  spread = 1,
): SpinPoseBlock {
  const r = lineupRatio(panel.w);
  const artW = l.artW && l.artW > 0 ? l.artW : l.artH * DEFAULT_ART_ASPECT;
  const spacingScale =
    lineupPackStep(artW / l.artH) /
    (LINEUP_ROW.step * LINEUP_REST_CAMERA.spacing);
  const ref = lineupView(0, LINEUP_REST_CAMERA, r, { spacingScale });
  const v = lineupView(dp, cam, r, {
    spacingScale: spacingScale * spread,
    capsule,
  });
  const t = Math.tan(((cam.fov / 2) * Math.PI) / 180);
  // The lineup maps its fov to the VIEWPORT height, so sizes match in px: so sizes match in px
  const projH = panel.viewH ?? panel.h;
  const pxX = v.sx * (projH / 2);
  const pxY = -v.sy * (projH / 2);
  const heightPx = (LINEUP_ROW.canWorldH / v.depth / t) * (projH / 2);
  return {
    dx: -d * l.step,
    dy: 0,
    // depth order only (the projection already sized the pack)
    z: -(v.depth - ref.depth) * 2,
    rotX: -v.ex,
    rotY: v.ey,
    rotZ: -v.ez,
    scale: heightPx / l.artH,
    dim: (soldOut ? SOLD_OUT_DIM : 1) * lineupLight(cam),
    fx: pxX / panel.w,
    fy: 0.5 + pxY / panel.h - panel.anchorY,
  };
}

/**
 * Row slot offsets (multiples of the set's size, 0 included) at which pack i
 * is drawn in the `tip` row, so the row runs off both edges however short the
 * set: a short set is repeated out to 24 cans. The caller draws each extra
 * slot with a CLONE of the pack's model (shared geometry and textures) and
 * passes the offset as `SpinCtx.copy`. The centred pack is always offset 0.
 */
export function lineupCopies(
  i: number,
  track: number,
  count: number,
  desktop: boolean,
): number[] {
  if (count < 1) return [0];
  const reach = (desktop ? LINEUP_ROW.reachDesktop : LINEUP_ROW.reachPhone) + 1;
  const dp = count > 1 ? wrapRow(i - track, count) : i - track;
  const out: number[] = [];
  const k = Math.ceil(reach / count) + 1;
  for (let c = -k; c <= k; c++) {
    const pos = dp + c * count;
    if (c === 0 || Math.abs(pos) < reach) out.push(c * count);
  }
  return out;
}

/**
 * The `tip` variant: the packshot look:
 * no own-axis turn; the row closes tight while a pitch ramp fans the packs
 * (12 deg more per pack on desktop, 29 on phones; the centre +11.5 deg) and
 * the whole row is seen through the packshot camera (pitch 10, yaw -9, roll
 * -10 deg, fov 30), all on one power1.inOut across the spin, as one
 * section tween. Fronts only, so the back-text glare clamp does not apply.
 * `ctx.exit` then plays the leave: camera drops, comes closer, levels, row
 * opens 0.47 -> 0.6, light goes out.
 */
export const lineupPose: SpinPoseFn = (rest, st, i, l, desktop, ctx) => {
  void desktop;
  const s = clamp01(st.spin);
  const exit = clamp01(ctx.exit ?? 0);
  if (!(s > 0) && !(exit > 0)) return { ...rest };
  const n = ctx.count;
  const d = i - st.track;
  const copy = ctx.copy ?? 0;
  const dp = (n > 1 ? wrapRow(d, n) : d) + copy;
  const w = quadInOut(s);
  const row = lineupRowBlock(
    dp,
    d,
    l,
    ctx.panel ?? DEFAULT_PANEL,
    lineupCameraAt(exit),
    !!ctx.soldOut,
    !!ctx.capsule,
    ctx.spread ?? 1,
  );
  // a wrapped pack or a copy takes its slot outright and fades in there
  if (Math.abs(dp - d) > 1e-9) return row;
  return {
    dx: lerp(rest.dx, row.dx, w) + 0,
    dy: lerp(rest.dy, row.dy, w) + 0,
    z: lerp(rest.z, row.z, w) + 0,
    rotX: lerp(rest.rotX, row.rotX, w) + 0,
    rotY: lerp(rest.rotY, row.rotY, w) + 0,
    rotZ: lerp(rest.rotZ, row.rotZ, w) + 0,
    scale: lerp(rest.scale, row.scale, w),
    dim: lerp(rest.dim, row.dim, w),
    fx: (row.fx ?? 0) * w + 0,
    fy: (row.fy ?? 0) * w + 0,
  };
};

/** The `tip` variant's reach fade: lerp(step 1's, the packshot's reach, the formation ease). */
export function lineupOpacity(
  st: Readonly<StageState>,
  i: number,
  desktop: boolean,
  count: number,
  copy = 0,
): number {
  const d = i - st.track;
  const s = clamp01(st.spin);
  if (!(s > 0)) return copy === 0 ? slotOpacity(d, desktop) : 0;
  const dp = (count > 1 ? wrapRow(d, count) : d) + copy;
  const reach = desktop ? LINEUP_ROW.reachDesktop : LINEUP_ROW.reachPhone;
  const restOp = Math.abs(dp - d) > 1e-9 ? 0 : slotOpacity(d, desktop);
  return lerp(restOp, reachOpacity(dp, reach), quadInOut(s));
}

/**
 * The exit for the full-turn row: the same camera move as the lineup's leave,
 * applied to the row on screen about the panel centre (zoom as the camera
 * comes closer, the drop, the roll levelling, the light out).
 */
function applyExit(
  b: PoseBlock,
  d: number,
  l: Readonly<StageLayout>,
  ctx: Readonly<SpinCtx>,
): SpinPoseBlock {
  const exit = clamp01(ctx.exit ?? 0);
  if (!(exit > 0)) return b;
  const panel = ctx.panel ?? DEFAULT_PANEL;
  const r = lineupRatio(panel.w);
  const cam = lineupCameraAt(exit);
  const a0 = lineupView(0, LINEUP_REST_CAMERA, r);
  const a1 = lineupView(0, cam, r);
  const zoom = a0.depth / a1.depth;
  const lev = quadInOut(exit);
  const yc = (panel.anchorY - 0.5) * panel.h;
  const X = d * l.step + b.dx;
  const Y = yc + b.dy;
  // the full-turn row keeps its own rest light and dims like the lineup on the exit
  const light = lineupLight(cam) / LINEUP_ROW.restLight;
  return {
    dx: X * zoom - d * l.step + 0,
    dy: Y * zoom - yc + 0,
    z: b.z,
    rotX: b.rotX,
    rotY: b.rotY,
    rotZ: b.rotZ * (1 - lev) + 0,
    scale: b.scale * zoom,
    dim: b.dim * light,
    fx: 0,
    // the camera drop moves the row up the screen
    fy: -(a1.sy - a0.sy) / 2 + 0,
  };
}

/** stage-pose.ts's private sold-out dim (0.4), mirrored. */
const SOLD_OUT_DIM = 0.4;

function normalise(p: PoseBlock): PoseBlock {
  return {
    dx: p.dx + 0,
    dy: p.dy + 0,
    z: p.z + 0,
    rotX: p.rotX + 0,
    rotY: p.rotY + 0,
    rotZ: p.rotZ + 0,
    scale: p.scale,
    dim: p.dim,
  };
}

/** Opacity with a given reach: 1 within it, fading to 0 one slot beyond. */
export function reachOpacity(d: number, reach: number): number {
  return clamp01(reach + 1 - Math.abs(d));
}

/**
 * The spin's reach fade: lerp(slotOpacity(d), reach fade of d', g).
 * Multiply by the swap fade and `introOpacity` as `stageOpacity` does.
 */
export function spinOpacity(
  st: Readonly<StageState>,
  i: number,
  desktop: boolean,
  count: number,
): number {
  const d = i - st.track;
  const s = clamp01(st.spin);
  if (!(s > 0)) return slotOpacity(d, desktop);
  const g = spinGather(s);
  const dp = spinRowPosition(s, i, st.track, count, desktop);
  const spin = reachOpacity(dp, spinConfig(desktop).REACH);
  const travels = spinTravels(count, desktop);
  const restOp = slotOpacity(d, desktop);
  // a wrapped pack is invisible at rest (see spinPose)
  return lerp(
    travels && Math.abs(wrapRow(d, count) - d) > 1e-9 ? 0 : restOp,
    spin,
    g,
  );
}

/**
 * `data-spinning` toggle: on above 0.02, off below 0.015 (hysteresis
 * 0.005), so a follow settling near the edge never flickers.
 */
export function spinningFlag(prev: boolean, s: number): boolean {
  return prev ? s > SPIN_LOCK - SPIN_LOCK_HYSTERESIS : s >= SPIN_LOCK;
}

/** Turn weight tween length. */
export const TURN_WEIGHT_MS = 400;

/**
 * One frame of a tile's turn weight. It starts moving only when `canFlip`
 * (spin 0, or the pack is off screen); a tween already under way finishes.
 */
export function stepTurnWeight(
  w: number,
  target: 0 | 1,
  dtMs: number,
  canFlip: boolean,
): number {
  if (w === target) return w;
  const moving = w > 0 && w < 1;
  if (!canFlip && !moving) return w;
  const step = Math.max(0, dtMs) / TURN_WEIGHT_MS;
  return target > w ? Math.min(target, w + step) : Math.max(target, w - step);
}

/** Re-exported so callers can type the lazily imported module. */
export type { SpinCtx, SpinPoseFn };
