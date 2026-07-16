// Pure spin physics for the Vault Room reel. No DOM, no React — see
// src/lib/__tests__/vault-reel.test.ts. Spec: slot-machine-redesign.md
// ("Momentum & Mass + final crawl" + timing masterplan).

/** Ratchet wind-up: the strip pulls back half a cell before release. */
export const WINDUP_MS = 180;
/** Full-speed blur phase (columns start together; stagger extends this phase).
 *  Lengthened (was 1500) to give the reel a longer readable spin whose cell
 *  crossings form a full accelerate→decelerate tick arc (the spin's sole audio;
 *  min crossing gap measured ~74ms, so every tick stays discrete/countable). */
export const BLUR_MS = 2200;
/** Friction phase: cells tick past slower and slower (longer = spec #33 landing).
 *  Lengthened (was 850) to stretch the decelerating per-cell ticks — each
 *  Pokémon crossing the winning line reads as its own audible tick. Raising this
 *  also SHRINKS blurPx (it's the denominator in the blur-travel derivation), so
 *  the strip-fit headroom actually grows. */
export const FRICTION_MS = 1300;
/** Suspense crawl — LAST column only. Slower (was 600) for a longer readable
 *  final descent, so the last few ticks space out and land on the winner. */
export const CRAWL_MS = 800;
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

// Tuned landing distances, in cells — the SINGLE source shared by BOTH
// trajectories (spinOffset and the press-launched pressSpinOffset), so a
// retune can never silently desync their landing feel.
/** Friction travel of the landing. */
const FRICTION_CELLS = 6;
/** Suspense-crawl travel (LAST column only). */
const CRAWL_CELLS = 2;
/** Settle overshoot depth past the payline; kept < 0.6 cells (test-bounded). */
const OVERSHOOT_CELLS = 0.32;

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
 *
 * NOTE: no production caller since the press-launched spin (pressSpinOffset)
 * replaced it. Kept deliberately as the tuned-physics derivation reference —
 * pressSpinOffset's distances/handoffs are derived from THIS trajectory — and
 * it stays test-covered in vault-reel.test.ts.
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
  const crawlPx = isLast ? itemH * CRAWL_CELLS : 0;
  const frictionPx = itemH * FRICTION_CELLS;
  const overshootPx = itemH * OVERSHOOT_CELLS;
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

/** Accel-phase duration for column `colIndex` — the blur phase plus the L→R
 *  stop stagger, exactly as columnDurationMs counts it. */
const accelMs = (colIndex: number) => BLUR_MS + colIndex * STOP_STAGGER_MS;

/**
 * Friction's share of the combined accel+friction distance when the handoff is
 * velocity-continuous: accel (easeInQuad over `accelMs`) exits at 2·A/T, friction
 * (easeOutCubic over FRICTION_MS) enters at 3·F/FRICTION_MS, so A = 3·F·T/(2·FRICTION_MS)
 * — the same derivation spinOffset uses, solved for F given a total span.
 */
const frictionShare = (colIndex: number) =>
  1 / (1 + (3 * accelMs(colIndex)) / (2 * FRICTION_MS));

/**
 * Ideal press-spin travel (px) for column `colIndex`: the forward distance that
 * makes the landing friction exactly FRICTION_CELLS deep under the fixed
 * phase durations — i.e. the same landing feel as spinOffset, launched from an
 * arbitrary position. The caller rounds `startPx + pressTravelPx(...)` to the
 * nearest cell center to pick the winner's strip index; pressSpinOffset then
 * absorbs the sub-cell rounding in its accel/friction split.
 */
export function pressTravelPx(
  colIndex: number,
  count: number,
  pitch: number,
): number {
  const frictionPx = pitch * FRICTION_CELLS;
  const span = frictionPx / frictionShare(colIndex); // accel + friction
  const crawlPx = colIndex === count - 1 ? pitch * CRAWL_CELLS : 0;
  return span + crawlPx - pitch / 2; // windup gives back half a cell
}

/**
 * Press-spin paint position (px, painted as `translateX(-px)`) at time `tMs`.
 * Unlike spinOffset (fixed start, reflected paint), this trajectory begins at
 * `startPx` — wherever the idle drift left the strip when the player pressed
 * spin — so the launch is CONTINUOUS with the ongoing idle motion: no teleport,
 * no content jump. Phases and durations are spinOffset's exactly (windup →
 * accel → friction → crawl(last col) → damped-overshoot settle, total =
 * columnDurationMs), so every downstream timer (stop clacks, tension window,
 * settle watchdog) stays valid. Distances are derived from the actual travel
 * `targetPx - startPx` with the same velocity-continuous handoffs.
 *
 * Precondition: targetPx − startPx ≈ pressTravelPx(...) (the caller picks the
 * winner index from it), which keeps every phase distance positive.
 */
export function pressSpinOffset(
  tMs: number,
  startPx: number,
  targetPx: number,
  colIndex: number,
  count: number,
  pitch: number,
): number {
  const isLast = colIndex === count - 1;
  const T = accelMs(colIndex);
  const windupPx = pitch / 2;
  const crawlPx = isLast ? pitch * CRAWL_CELLS : 0;
  // Combined accel+friction span, measured from the wound-back position.
  const span = targetPx - startPx + windupPx - crawlPx;
  const frictionPx = span * frictionShare(colIndex);
  const accelPx = span - frictionPx;
  const overshootPx = pitch * OVERSHOOT_CELLS;

  const t1 = WINDUP_MS;
  const t2 = t1 + T;
  const t3 = t2 + FRICTION_MS;
  const t4 = t3 + (isLast ? CRAWL_MS : 0);
  const t5 = t4 + SETTLE_MS;

  if (tMs <= 0) return startPx;
  if (tMs >= t5) return targetPx;
  if (tMs < t1) {
    // Ratchet wind-up: the strip pulls back half a cell before release.
    return startPx - windupPx * easeOutQuad(tMs / t1);
  }
  const from = startPx - windupPx;
  if (tMs < t2) {
    // Accelerate forward; easeInQuad exits at friction's entry velocity.
    return from + accelPx * easeInQuad((tMs - t1) / T);
  }
  if (tMs < t3) {
    // Friction: decelerating approach to the crawl/settle position.
    return (
      targetPx -
      crawlPx -
      frictionPx +
      frictionPx * easeOutCubic((tMs - t2) / FRICTION_MS)
    );
  }
  if (tMs < t4) {
    // Crawl: slow, readable, last two cells (last column only).
    return targetPx - crawlPx + crawlPx * easeOutQuad((tMs - t3) / CRAWL_MS);
  }
  // Settle: damped overshoot PAST the payline, easing back to rest.
  return targetPx + overshootPx * settleShape((tMs - t4) / SETTLE_MS);
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
