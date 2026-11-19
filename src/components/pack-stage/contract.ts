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
import type { Observable } from './stage-motion';

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
/**
 * ADDITION (pack type chips): one language a selection can narrow to, with
 * the ids it keeps (packs in that language plus packs with none), in the
 * stage's order. Computed on the server (`shelfPacks`).
 */
export type StageLanguageCut = {
  key: string;
  /** Full name ("English"), also the accessible name. */
  label: string;
  /** Short visible label for narrow screens ("EN"). */
  short: string;
  ids: string[];
};
/**
 * ADDITION (pack type chips): one chip of a category. The first is always
 * "All" (every pack); then one per pack type in `shelvePacks` order, present
 * only when the category has two or more type shelves. `caption` is the
 * shelf's composition heading (`CATALOG_GROUP_HEADING`) only when every pack
 * on it shares one `catalogGroupOf` that is graded or raw, else null.
 * `languages` is empty unless the shelf carries two or more languages.
 */
export type StageShelf = {
  key: string;
  label: string;
  caption: string | null;
  count: number;
  /** The shelf's pack ids in the stage's order. */
  ids: string[];
  languages: StageLanguageCut[];
};
export type StageCategory = {
  id: string;
  packs: StagePack[];
  /** ADDITION: "All" first, then the type shelves (see StageShelf). */
  shelves: StageShelf[];
};
/** ADDITION: what a coming row will show, handed over at the tap. */
export type StageNextRow = { packs: readonly StagePack[]; centre: number };
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
  track: Observable<number>;
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
    intro: Observable<number>;
    swap: Observable<number>;
    pointerX: Observable<number>;
    pointerY: Observable<number>;
  };
  /** Resolves once settled: 3D prepared (`'3d'`/`'lite'`) or `'flat'`. Never rejects. */
  whenSettled(): Promise<StageMode>;
  /** Park the float-in at its start (`intro = 0`). Call while the loader covers the page. */
  holdIntro(): void;
  /** Run the float-in (`intro` 0 -> 1). Call from `BrandLoader` `onLeave`. Instant under reduced motion. */
  playIntro(): Promise<void>;
  /**
   * Category switch (and pack type / language change): sinks the current
   * packs (250 ms), calls `apply()` (show the new row; its `attach` must have
   * run when `apply` returns, so commit it synchronously), then raises the new
   * ones (450 ms). `next` (ADDITION) names the coming row at the tap, so its
   * packs load during the sink.
   */
  swapCategory(apply: () => void, next?: StageNextRow | null): Promise<void>;
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
  /**
   * ADDITION: `centre` is the new list's starting track (its index space).
   * Packs already resident, or staged by `prefetch`, are carried by key.
   */
  setPacks(p: StageRuntimePack[] | null, centre?: number): void;
  /**
   * ADDITION: at a tap, before the coming list is set: load and upload the
   * packs it will draw first (centre +- reach), inside the byte budget, and
   * keep the ones already resident. The next `setPacks` adopts them; a newer
   * `prefetch` (or null) drops what it no longer wants.
   */
  prefetch(p: StageRuntimePack[] | null, centre: number): void;
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
