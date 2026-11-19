/**
 * Pack stage: the binding contract shared by every work package
 * (plan section 10, docs/research/home-3d/pack-stage/plan.md).
 *
 * Imports nothing heavy: types only, so the page, the provider and the async
 * three.js runtime can all depend on it without pulling each other in.
 *
 * `poseAt` is implemented in `./stage-pose`. `createStageRuntime` is only a
 * TYPE here: the runtime is a separate async chunk (`runtime/stage-runtime.ts`,
 * webpack chunk `pack-stage-3d`) and is reached solely through the dynamic
 * import in `Stage3dProvider.tsx`.
 */
import type { MotionValue } from 'motion/react';

export type StageMode = 'pending' | 'flat' | '3d' | 'lite';
export type StageArt = {
  front: string;
  frontHalf: string;
  width: number;
  height: number;
};
export type StagePack = {
  id: string;
  name: string;
  priceMyr: number;
  priceLabel: string;
  href: string;
  soldOut: boolean;
  image: string;
  art3d: StageArt | null;
  chaseLabel: string | null;
  buybackPercent: number;
  boost: boolean;
  ticket: boolean;
};
export type StageCategory = { id: string; packs: StagePack[] };
export type StageState = {
  intro: number;
  track: number;
  swap: number;
  pointerX: number;
  pointerY: number;
  idle: number;
  focus: number;
  turn: number;
};
export type StageLayout = {
  cx: number;
  cy: number;
  step: number;
  artH: number;
  /**
   * ADDITION (optional): the art box width. Pictures are `object-fit: contain`
   * in an `artW x artH` box, so a pack wider than the box draws shorter than
   * `artH`; the runtime fits each model the same way.
   */
  artW?: number;
}; // host CSS px
export type Pose = {
  dx: number;
  dy: number;
  z: number;
  rotX: number;
  rotY: number;
  scale: number;
  dim: number;
};

// `poseAt` lives in `./stage-pose` (pure); re-exported so the contract path works too.
export { poseAt } from './stage-pose';

/** Signature of `poseAt` (implemented in `./stage-pose`). */
export type PoseAtFn = (
  s: StageState,
  i: number,
  l: StageLayout,
  desktop: boolean,
  soldOut: boolean,
) => Pose;

export interface StageSlotSource {
  categoryId: string;
  packs: readonly StagePack[];
  artElement(i: number): HTMLElement | null;
  track: MotionValue<number>;
}

export interface Stage3dApi {
  mode: StageMode;
  ready: boolean;
  state: StageState;
  attach(src: StageSlotSource): () => void;
  wake(): void;
}

/**
 * ADDITION to the plan's block: what `useStage3d()` returns. A superset of
 * `Stage3dApi`; every member is identity-stable except `mode` and `ready`.
 */
export interface Stage3dStage extends Stage3dApi {
  /**
   * Motion values mirrored into `state` (CSS tiles bind to these with
   * `useTransform`; the canvas reads `state`). `track` is the attached
   * source's own value.
   */
  values: {
    intro: MotionValue<number>;
    swap: MotionValue<number>;
    pointerX: MotionValue<number>;
    pointerY: MotionValue<number>;
  };
  /** Resolves once settled: 3D prepared (`'3d'`/`'lite'`) or `'flat'`. Never rejects. */
  whenSettled(): Promise<StageMode>;
  /** Park the float-in at its start (`intro = 0`). Call while the loader covers the page. */
  holdIntro(): void;
  /** Run the float-in (`intro` 0 -> 1). Call from `BrandLoader` `onLeave`. Instant under reduced motion. */
  playIntro(): Promise<void>;
  /**
   * Category switch: sinks the current packs (250 ms), calls `apply()` (show
   * the new panel; its `attach` follows), then raises the new ones (450 ms).
   */
  swapCategory(apply: () => void): Promise<void>;
  /** Runtime numbers for `?debug=1`; null without a runtime. */
  stats(): StageRuntimeStats | null;
}

/** ADDITION: an attach source may supply its own layout instead of the provider's measure. */
export interface StageSlotSourceWithLayout extends StageSlotSource {
  layout?(): StageLayout | null;
}

// Slot markup: <li data-stage-tile data-pack-id data-index> ... <div data-stage-art data-live="0|1"><img|Image/></div>
// The provider writes data-live; CSS [data-live="1"] img { opacity:0 }.

// Runtime (async chunk): `runtime/stage-runtime.ts` must export
//   export function createStageRuntime(i: StageRuntimeInput): StageRuntime;
export type StageRuntimeFailReason = 'context-lost' | 'too-slow' | 'error';
export type StageRuntimeTier = 'full' | 'lite';

export type StageRuntimeInput = {
  canvas: HTMLCanvasElement;
  tier: StageRuntimeTier;
  desktop: boolean;
  onFail(r: StageRuntimeFailReason): void;
  /**
   * ADDITION to the plan's block (optional, default true): pass to
   * `WebGLRenderer`. The provider sends `false` only under the preview's
   * `?stage=3d|lite` override, so headless QA (SwiftShader) can render.
   */
  failIfMajorPerformanceCaveat?: boolean;
};

export type StageRuntimePack = {
  id: string;
  art: StageArt;
  soldOut: boolean;
  index: number;
};

export type StageRuntimeStats = {
  textures: number;
  geometries: number;
  programs: number;
  gpuBytesEstimate: number;
};

export type StageRuntime = {
  resize(w: number, h: number, dpr: number): void;
  setPacks(p: StageRuntimePack[] | null): void;
  setLayout(l: StageLayout): void;
  /** ADDITION: optional start centre (the attached track); default: first pack in stock. */
  prepare(track?: number): Promise<void>;
  render(
    s: Readonly<StageState>,
    now: number,
  ): { live: string[]; wantsFrame: boolean };
  stats(): StageRuntimeStats;
  dispose(): void;
};

export type CreateStageRuntime = (i: StageRuntimeInput) => StageRuntime;

/** Shape of the async chunk module `./runtime/stage-runtime`. */
export type StageRuntimeModule = { createStageRuntime: CreateStageRuntime };
