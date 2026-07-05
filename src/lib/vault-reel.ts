// Pure spin physics + 3D barrel curvature for the Vault Room reel. No DOM, no
// React — see src/lib/__tests__/vault-reel.test.ts. Spec: slot-machine-redesign.md
// ("Momentum & Mass + final crawl" + timing masterplan).
import { POKEDEX_MAX } from './reel';

/** Ratchet wind-up: the strip pulls back half a cell before release. */
export const WINDUP_MS = 180;
/** Full-speed blur phase (columns start together; stagger extends this phase). */
export const BLUR_MS = 1500;
/** Friction phase: cells tick past slower and slower (longer = spec #33 landing). */
export const FRICTION_MS = 850;
/** Suspense crawl — LAST column only. */
export const CRAWL_MS = 600;
/** Eased overshoot + settle (longer so the landing reads unhurried, spec #33). */
export const SETTLE_MS = 380;
/** Per-column stop stagger (L→R). */
export const STOP_STAGGER_MS = 400;
/** Rows visible in the reel window. */
export const VISIBLE_CELLS = 5;
/**
 * Width/height ratio of EVERY card-shaped surface (reel tiles, slab back and
 * front). Shared so the landed tile → slab morph reads as one object growing
 * (spec decision #16 — shape-synced reveal).
 */
export const CARD_ASPECT = 3 / 4.2;
/**
 * Winner's strip index for the VAULT reel — LOW on the strip because cells
 * stream TOP → BOTTOM (spec #22): all pre-roll travel comes from the cells
 * ABOVE (after) the winner, so a low index leaves ~38 cells of genuine blur
 * runway inside the fixed strip (spec decision #31). The bounds invariant
 * (no frame paints past either strip end at max window height) is test-encoded.
 */
export const VAULT_WIN_INDEX = 9;
/** Decoy sprites cycle a small pool — a real slot repeats its symbol set, and
 *  12 distinct images per column (instead of 47) slashes decode/network cost. */
export const VAULT_DECOY_POOL = 12;

/**
 * Vault analog of `buildDexStrip` (spec decision #31): decoys repeat from a
 * small deterministic pool instead of 47 unique dexes; winner pinned at
 * `winIndex`. Same geometry validation as buildDexStrip.
 */
export function buildVaultStrip(
  winnerDex: number | null,
  length: number,
  winIndex: number,
  poolSize = VAULT_DECOY_POOL,
): number[] {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError('buildVaultStrip: length must be a positive integer');
  }
  if (!Number.isInteger(winIndex) || winIndex < 0 || winIndex >= length) {
    throw new RangeError(
      'buildVaultStrip: winIndex must be within [0, length)',
    );
  }
  const safeWinner =
    winnerDex !== null &&
    Number.isInteger(winnerDex) &&
    winnerDex >= 1 &&
    winnerDex <= POKEDEX_MAX
      ? winnerDex
      : 1;
  const strip = Array.from(
    { length },
    (_, i) => (((i % poolSize) * 167 + 13) % POKEDEX_MAX) + 1,
  );
  strip[winIndex] = safeWinner;
  return strip;
}

const easeOutQuad = (p: number) => 1 - (1 - p) * (1 - p);
const easeInQuad = (p: number) => p * p;
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);

/**
 * Settle overshoot shape g(p), p in [0,1] (spec decision #33): a damped
 * single-lobe `p²·e^{-k p}` normalized to peak 1. g(0)=0 with g'(0)=0 (eases IN
 * from the friction/crawl's near-zero arrival velocity — no jerk), a quick dip
 * to 1 at p≈2/k, then a slow recover to ≈0 by p=1 with g'(1)≈0. That asymmetry
 * (fast overshoot, slow return) reads as a natural mechanical settle instead of
 * the old half-sine's instant velocity kick.
 */
const SETTLE_K = 9;
const SETTLE_PEAK = (2 / SETTLE_K) ** 2 * Math.exp(-2); // max of p²e^{-kp}
const settleShape = (p: number) =>
  (p * p * Math.exp(-SETTLE_K * p)) / SETTLE_PEAK;

/** Total run time of column `colIndex` of `count` (all columns start together). */
export function columnDurationMs(colIndex: number, count: number): number {
  const isLast = colIndex === count - 1;
  return (
    WINDUP_MS +
    BLUR_MS +
    FRICTION_MS +
    (isLast ? CRAWL_MS : 0) +
    SETTLE_MS +
    colIndex * STOP_STAGGER_MS
  );
}

/** When the LAST column settles — sizes the watchdog and phase handoff. */
export function spinTotalMs(count: number): number {
  return columnDurationMs(count - 1, count);
}

/**
 * Strip offset (px) at time `tMs`, painted by the caller as `translateY(-offset)`.
 * Cells stream TOP → BOTTOM (spec decision #22): the strip starts with the
 * winner sitting ABOVE the payline and DESCENDS into it, so `offset` starts
 * HIGH (target + pre-roll travel) and eases DOWN to `targetPx`. The wind-up
 * pulls UP half a cell first (offset spikes ABOVE the start), then releases
 * downward. Piecewise:
 *   wind-up (offset rises above start = strip pulls up) → blur (ease-in to
 *   speed, ~18-27 cells stream past) → friction (ease-out, offset still
 *   falling) → crawl (last column only, slow readable descent) → settle
 *   (eased damped overshoot BELOW the target = winner dips under the payline,
 *   then eases back to rest).
 * Two handoffs are velocity-continuous (no jerk):
 *   • blur → friction: `blurPx` is derived so the blur's exit velocity equals
 *     friction's entry velocity (3·frictionPx/FRICTION_MS) for any FRICTION_MS
 *     (spec #31/#33). Total travel needs the winner pinned LOW on the strip
 *     (VAULT_WIN_INDEX) — the strip fit is test-encoded.
 *   • friction/crawl → settle: friction (easeOutCubic) and crawl (easeOutQuad)
 *     both arrive at ~zero velocity, and settleShape STARTS at zero velocity,
 *     so the landing eases in instead of kicking (spec #33 — natural landing).
 */
export function spinOffset(
  tMs: number,
  targetPx: number,
  colIndex: number,
  count: number,
  itemH: number,
): number {
  const isLast = colIndex === count - 1;
  const blur = BLUR_MS + colIndex * STOP_STAGGER_MS;
  const windupPx = itemH / 2;
  const crawlPx = isLast ? itemH * 2 : 0;
  const frictionPx = itemH * 6;
  // Settle overshoot depth (below the payline); kept < 0.6 cells (test-bounded).
  const overshootPx = itemH * 0.32;
  // Blur travel sized so the blur's EXIT velocity equals friction's ENTRY
  // velocity (easeOutCubic'(0) = 3·frictionPx/FRICTION_MS), keeping the handoff
  // velocity-continuous for ANY FRICTION_MS. Derived, not a magic divisor.
  const blurPx = (3 * frictionPx * blur) / (2 * FRICTION_MS);
  // The winner starts this far ABOVE its landed (centered) position and descends.
  const startPx = targetPx + frictionPx + crawlPx + blurPx;

  const t1 = WINDUP_MS;
  const t2 = t1 + blur;
  const t3 = t2 + FRICTION_MS;
  const t4 = t3 + (isLast ? CRAWL_MS : 0);
  const t5 = t4 + SETTLE_MS;

  if (tMs <= 0) return startPx;
  if (tMs >= t5) return targetPx;

  // blurEnd is where the fast blur phase hands off to friction — one friction +
  // crawl span above the target.
  const blurEnd = targetPx + frictionPx + crawlPx;
  if (tMs < t1) {
    // Wind-up: strip pulls UP half a cell → offset rises ABOVE the start.
    return startPx + windupPx * easeOutQuad(tMs / t1);
  }
  if (tMs < t2) {
    // Accelerate downward from the wound-up position to blurEnd; easeInQuad ends
    // at max velocity, handing off to the decelerating friction phase.
    const from = startPx + windupPx;
    return from + (blurEnd - from) * easeInQuad((tMs - t1) / blur);
  }
  if (tMs < t3) {
    // Friction: descend the friction span, decelerating.
    return blurEnd - frictionPx * easeOutCubic((tMs - t2) / FRICTION_MS);
  }
  if (tMs < t4) {
    // Crawl: slow, readable, near-linear descent across the last two cells.
    return targetPx + crawlPx - crawlPx * easeOutQuad((tMs - t3) / CRAWL_MS);
  }
  // Settle: eased damped overshoot BELOW the target (winner dips under the
  // payline, then eases back). settleShape starts at ZERO velocity so it picks
  // up seamlessly from friction/crawl (which arrive near zero velocity) — no
  // kick, no sudden stop (spec decision #33).
  const p = (tMs - t4) / SETTLE_MS;
  return targetPx - overshootPx * settleShape(p);
}

/** Rim wrap cap: 90° would render the rim cell as a zero-height sliver. */
const CYL_MAX_RAD = (82 * Math.PI) / 180;
/** Projected drum depth (px) — how far the rim recedes at full wrap (#36). */
const CYL_DEPTH_PX = 150;
/** Center bulge (#39): the payline row swells this much toward the viewer, so
 *  the winning Pokémon is the biggest cell; eases to 0 (scale 1) at the rim. */
const CYL_BULGE = 0.3;
/** cos at the wrap cap — the bulge normalizer so the rim lands exactly at 1. */
const CYL_COS_MIN = Math.cos(CYL_MAX_RAD);

/**
 * TRUE CYLINDER projection driven by ARC angle (spec decisions #36 + #37b —
 * "mouse seen from above"): the strip is the surface of a drum with a
 * horizontal axis, so a cell `s` px along the strip from the payline sits at
 * wrap angle θ = s/R (equal strip steps = equal angle steps). Then:
 *   • painted position remaps to the PROJECTION y = R·sin θ — returned as
 *     `translateYPx` = R·sinθ − s. Rows visibly bunch toward the rims, and
 *     during the spin symbols sweep fastest through the center band (#37b);
 *   • the middle band is FLAT — nearly untouched until ~40% out (it faces the
 *     viewer: closest, brightest, full size);
 *   • rows wrap away with ACCELERATING tilt toward the rim (near edge-on at
 *     the cap — the drum horizon);
 *   • height compresses as cos θ (via the rotation), width stays constant —
 *     a cylinder keeps its width; apparent size falls off through real
 *     perspective depth z = −DEPTH·(1−cos θ) instead of a uniform scale;
 *   • brightness follows drum lighting: 0.22 + 0.78·cos θ.
 * Beyond the cap every output pins at the cap value except the position,
 * which keeps sliding linearly out of the window (no rim pile-up; the #37c
 * rim tunnels hide the remainder).
 * `radiusPx` is half the window height; `distPx` positive = below center.
 */
export function cellCurve(
  distPx: number,
  radiusPx: number,
): {
  rotateXDeg: number;
  scale: number;
  brightness: number;
  translateZPx: number;
  translateYPx: number;
} {
  const sign = Math.sign(distPx);
  const sCap = CYL_MAX_RAD * radiusPx;
  const s = Math.min(Math.abs(distPx), sCap);
  const theta = s / radiusPx;
  const cos = Math.cos(theta);
  return {
    rotateXDeg: -((theta * 180) / Math.PI) * sign + 0, // coerce signed zero
    // Center bulge (#39): biggest dead-center (cos=1 → 1+CYL_BULGE), easing to
    // exactly 1 at the rim (cos=CYL_COS_MIN). Never below 1 — a cylinder front
    // never shrinks below its true width; apparent shrink is perspective depth.
    scale: 1 + CYL_BULGE * ((cos - CYL_COS_MIN) / (1 - CYL_COS_MIN)),
    brightness: 0.22 + 0.78 * cos,
    translateZPx: -CYL_DEPTH_PX * (1 - cos) + 0, // coerce signed zero
    // Remap to the projected position; constant past the cap so far cells
    // keep sliding out of the window instead of stacking at the rim.
    translateYPx: (radiusPx * Math.sin(theta) - s) * sign + 0,
  };
}

/** Peak `filter: blur()` radius (px) at full spin speed — capped so a phone
 *  GPU never re-rasterizes a huge blur radius per frame (spec #38). */
const MAX_BLUR_PX = 5;

/**
 * Motion-blur profile for a moving reel cell (spec decision #38). `scaleY` +
 * `opacity` are the transform-only vertical smear/ghost; `blurPx` is a REAL
 * `filter: blur()` radius the caller applies to the moving strip. All three are
 * 0/identity at rest and grow with |velocity|, so the reel blurs while streaming
 * and lands sharp as it settles. blurPx is capped and ramps gently (×1.6) so
 * settle-speed (~0.68px/ms) is a soft trace, full speed (~2.8px/ms) a clear blur.
 */
export function blurStretch(velocityPxPerMs: number): {
  scaleY: number;
  opacity: number;
  blurPx: number;
} {
  const v = Math.abs(velocityPxPerMs);
  return {
    scaleY: 1 + Math.min(0.35, v * 0.06),
    opacity: 1 - Math.min(0.45, v * 0.08),
    blurPx: Math.min(MAX_BLUR_PX, v * 1.6),
  };
}
