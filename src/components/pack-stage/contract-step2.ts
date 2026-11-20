/**
 * Pack stage, step 2: the contract additions (plan-step2.md sections 8 and
 * 10.9) that `contract.ts` does not have yet. Types only.
 *
 * Written to be FOLDED INTO `contract.ts` by the integration step: every
 * `...Step2` type below is "the existing type plus these fields", so moving
 * the fields into the existing declarations and deleting this file is the
 * whole merge. Nothing here changes `contract.ts`.
 */
import type { Pose, StageLayout, StageState } from './contract';

/**
 * What a back prints: structurally `PackBackDetails` from
 * `@/components/pack-3d/pack-print` (the same fields, so either is assignable
 * to the other). Restated because the stage's import guard
 * (`__tests__/no-server-reads.test.ts`) allows `pack-3d` imports only under
 * `runtime/`, type-only ones included. At integration, either keep this or
 * import the real type and widen the guard to type-only imports.
 */
export type PackBackDetails = {
  price: string | null;
  productLine: string[];
  odds: { label: string; chance: string }[] | null;
  buyback: { headline: string; rule: string } | null;
};

/**
 * A number that can be read and watched. Structural, so today's
 * `MotionValue<number>` and the local scheduler's own value type
 * (`stage-motion.ts`, being written elsewhere) both satisfy it.
 * -> contract.ts as `Observable<number>` (section 2).
 */
export type Observable<T> = {
  get(): T;
  on(event: 'change', callback: (v: T) => void): () => void;
};

/** -> `StageState += { spin }`: 0..1, the followed progress through the spin pin. */
export type StageStateStep2 = StageState & { spin: number };

/**
 * -> `Pose += { fx, fy, rotZ }`.
 * - `fx`: offset as a fraction of the host width (CSS: `fx * 100cqw`).
 * - `fy`: offset as a fraction of the panel height (CSS: `fy * 100cqh`).
 * - `rotZ`: radians, CSS `rotateZ` (clockwise on screen). three.js:
 *   `rotation.z = -rotZ`, Euler order 'ZYX' (see integration-notes.md: the
 *   bench also measured 'ZXY').
 */
export type PoseStep2 = Pose & { fx: number; fy: number; rotZ: number };

/** The rest-carousel block `spinPose` and `focusPose` work on (no fx / fy). */
export type PoseBlock = {
  dx: number;
  dy: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  scale: number;
  dim: number;
};

/** A spin pose may also offset by panel fractions (the Ciao row and the exit). */
export type SpinPoseBlock = PoseBlock & { fx?: number; fy?: number };

export type SpinPoseFn = (
  rest: Readonly<PoseBlock>,
  s: Readonly<StageStateStep2>,
  i: number,
  l: Readonly<StageLayout>,
  desktop: boolean,
  ctx: Readonly<SpinCtx>,
) => SpinPoseBlock;

/**
 * The stage panel in host CSS px, and where the art centre sits in it (cy / h).
 * `viewH`: the viewport height (Ciao maps its fov to it; default `h`).
 */
export type SpinPanel = {
  w: number;
  h: number;
  anchorY: number;
  viewH?: number;
};

/**
 * Per-tile spin context (section 10.9).
 * - `count`: packs in the attached set.
 * - `turn`: this tile's turn weight, 0 = lean mode .. 1 = full own-axis turn
 *   (tweened over 400 ms, changed only at spin 0 or off screen; 10.7).
 * - `lean`: `LEAN` for packs, `CAPSULE_LEAN` for capsules.
 * - `spinPose`: the lazily imported `stage-spin.ts` function; absent = no
 *   spin term (the CSS tiles before the idle import).
 * - `soldOut`: ADDITION to 10.9's block: the row's dim is "soldOut ? 0.4 : 1"
 *   and `spinPose` has no other way to know it (the rest block's dim also
 *   carries the desktop distance dim, which reaches 0.35).
 */
export type SpinCtx = {
  count: number;
  turn: number;
  lean: number;
  spinPose?: SpinPoseFn;
  soldOut?: boolean;
  /**
   * ADDITION (Ciao motion sheet, 2026-11-20): 0..1 through the exit after the
   * pin, the camera drop scrubbed by free scroll over 1.25 panels.
   */
  exit?: number;
  /** ADDITION: the panel, needed by the Ciao row's projection and by the exit. */
  panel?: SpinPanel;
  /** ADDITION (`tip` row): row-slot offset of this drawn copy (`ciaoCopies`); 0 = the pack itself. */
  copy?: number;
  /** ADDITION (`tip` row): a capsule, whose ramp is clamped to the owner's tip limits. */
  capsule?: boolean;
};

/** `/home-preview?spin=` (10.14): `paged` is the default, Ciao's trigger. */
export type SpinVariant = 'paged' | 'free' | 'tip';

/** -> contract.ts (10.9). Document px; null in focus or under reduced motion. */
export interface StageSpinSource {
  range(): { start: number; length: number } | null;
}

/** -> contract.ts (section 8). One chapter stop of the focus flow. */
export type StageStopKind = 'back' | 'tier' | 'odds';
export type StageStop = { y: number; kind: StageStopKind };

/** -> contract.ts (section 8). */
export interface StageScrollSource {
  stops(): readonly StageStop[] | null;
}

/**
 * Focus context for `focusPose` (stage-focus.ts). Fractions, so the CSS tiles
 * and the runtime share it.
 * - `index`: the focused pack's index in the attached set.
 * - `anchorY`: the measured art centre `cy / panelHeight` (where fy = 0 is).
 * - `stops`: the chapter stops as measured (null until measured: a single
 *   'back' stop is assumed).
 * - `leaveFrom`: set while returning to the row (section 1): the focus value
 *   the visitor left from, so the pack goes straight home from where it was
 *   drawn instead of replaying the chapters.
 * - `yawBeat`: desktop's timed yaw beat (radians, tweened by the caller).
 */
export type FocusCtx = {
  index: number;
  anchorY: number;
  stops: readonly StageStop[] | null;
  leaveFrom?: number;
  yawBeat?: number;
};

/** -> `Stage3dStage.focusPack(r, o)` request (section 8). */
export type StageFocusRequest = {
  index: number;
  packId: string;
  back: PackBackDetails | null;
};

/** -> `StageRuntime.setFocus(f)` (section 8). `withBack` is false whenever `canTurn` is. */
export type StageFocusDecl = {
  id: string;
  details: PackBackDetails | null;
  withBack: boolean;
};

export type StageBackStatus = 'none' | 'loading' | 'ready' | 'unavailable';
export type StageRenderBackStatus = 'none' | 'loading' | 'ready' | 'failed';

/** -> `StageRuntime.setSpinBacks(b)` entries (10.5). */
export type StageSpinBack = { id: string; details: PackBackDetails | null };

/** -> `Stage3dStage += {...}` (sections 8 and 10.9). */
export interface Stage3dStageStep2Additions {
  values: {
    focus: Observable<number>;
    turn: Observable<number>;
    spin: Observable<number>;
  };
  focusPack(
    r: StageFocusRequest | null,
    o?: { instant?: boolean },
  ): Promise<void>;
  updateBack(back: PackBackDetails | null): void;
  bindScroll(s: StageScrollSource): () => void;
  backStatus(): StageBackStatus;
  bindSpin(s: StageSpinSource): () => void;
  /** True on the render after an "All packs" arrival (stage-arrival.ts). */
  arrival: boolean;
}

/** -> `StageRuntimeInput += { fonts }`. */
export type StageRuntimeInputStep2Additions = { fonts?: { sans: string } };

/** -> `StageRuntime += {...}`; `render()` also gains `back` (section 8). */
export interface StageRuntimeStep2Additions {
  setFocus(f: StageFocusDecl | null): void;
  setSpinBacks(b: readonly StageSpinBack[] | null): void;
}

/** -> `ResidencyInput += { wrap }` (10.9): pack count when the spin row wraps, else null. */
export type ResidencyInputStep2Additions = { wrap: number | null };
