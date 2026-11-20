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
/**
 * ADDITION (WP-G): `shape: 'capsule'` marks a capsule's 3D set; its `front` and
 * `frontHalf` are the pack's own picture and `width` x `height` the picture
 * its model was fitted to. Absent: a sleeve.
 */
export type StageArt = {
  front: string;
  frontHalf: string;
  width: number;
  height: number;
  shape?: 'capsule';
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
  /** Step 2 (10.9): 0..1, the progress through the spin pin (paged or followed). */
  spin: number;
  /**
   * ADDITION (Ciao motion sheet): 0..1 through the exit after the pin, the
   * camera move that takes the formed row out of the top. Kept in the state
   * (not only in `SpinCtx`) so the runtime redraws when it changes.
   */
  exit: number;
  /**
   * The focused pack, written by the focus chunk while `focus > 0` (absent
   * otherwise). The runtime and the tiles read the same declaration.
   */
  focusOn?: StageFocusOn | null;
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
/**
 * Step 2 adds `fx`, `fy` and `rotZ`:
 * - `fx`: offset as a fraction of the host width (the Ciao row's projection).
 * - `fy`: offset as a fraction of the host (panel) height.
 * - `rotZ`: radians, CSS `rotateZ` (clockwise on screen), applied before
 *   `rotateY` and `rotateX`. three.js: `rotation.set(-rotX, rotY, -rotZ, 'ZYX')`.
 */
export type Pose = {
  dx: number;
  dy: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  scale: number;
  dim: number;
  fx: number;
  fy: number;
};

/** The rest-carousel block `spinPose`, `ciaoPose` and `focusPose` work on (no fx / fy). */
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
  s: Readonly<StageState>,
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
 * Per-tile spin context (section 10.9 and the Ciao motion sheet).
 * - `count`: packs in the attached set.
 * - `turn`: this tile's turn weight (0 = lean .. 1 = full own-axis turn); the
 *   Ciao row ignores it.
 * - `lean`: `LEAN` for packs, `CAPSULE_LEAN` for capsules.
 * - `spinPose`: the lazily loaded row function (`ciaoPose`); absent = no spin
 *   term (the CSS tiles before the idle import).
 * - `soldOut`: the row's dim is "soldOut ? 0.4 : 1".
 * - `exit`: 0..1 through the exit (the camera move after the pin).
 * - `panel`: the panel, for the Ciao row's projection and the exit.
 * - `copy`: row-slot offset of this drawn repeat (`ciaoCopies`); 0 = the pack.
 * - `capsule`: a capsule, whose ramp is clamped to the owner's tip limits.
 */
export type SpinCtx = {
  count: number;
  turn: number;
  lean: number;
  spinPose?: SpinPoseFn;
  soldOut?: boolean;
  exit?: number;
  panel?: SpinPanel;
  copy?: number;
  capsule?: boolean;
};

/** The spin row's opacity rule (`ciaoOpacity`), when loaded. */
export type SpinOpacityFn = (
  st: Readonly<StageState>,
  i: number,
  desktop: boolean,
  count: number,
  copy?: number,
) => number;

/**
 * What drives `spin`: `paged` (DEFAULT, Ciao's trigger: one gesture plays one
 * 1.5 s move) or `free` (the preview's `?spin=free`: the spin follows the
 * scroll). `tip` is the old name of the Ciao row look, kept for the unwired
 * full-turn helpers in `stage-spin.ts`.
 */
export type SpinVariant = 'paged' | 'free' | 'tip';
export type SpinMode = 'paged' | 'free';

/**
 * The page's pin (10.9), as elements: the spin chunk measures the range from
 * them (never per frame) and sets the panel's flags. `flow` holds the CSS
 * variables, `wrap` is the pin (its descendants' gestures page the spin),
 * `panel` the sticky stage section. `empty`: no packs, no pin.
 */
export interface StageSpinSource {
  flow: HTMLElement;
  wrap: HTMLElement;
  panel: HTMLElement;
  empty: boolean;
}

/** The pin's scroll range, document px (whole numbers). */
export type SpinRange = { start: number; length: number; exit: number };

/**
 * What a back prints: structurally `PackBackDetails` from
 * `@/components/pack-3d/pack-print` (restated: the stage's import guard
 * allows `pack-3d` imports only under `runtime/`).
 */
export type PackBackDetails = {
  price: string | null;
  productLine: string[];
  odds: { label: string; chance: string }[] | null;
  buyback: { headline: string; rule: string } | null;
};

// --- Focus (plan-focus-ciao) -----------------------------------------------

/** The focused pack's stops (plan-focus-ciao section 2), in order. */
export type StageStopKind =
  'front' | 'tophits' | 'odds' | 'buyback' | 'pulls' | 'closing';
export type StageStop = { y: number; kind: StageStopKind };

export interface StageScrollSource {
  stops(): readonly StageStop[] | null;
}

/** A lit rect of the back image (fractions: x across, y along from the top). */
export type SpotRect = { x0: number; y0: number; x1: number; y1: number };

/**
 * The focused pack at one stop (plan-focus-ciao section 2): centre as panel
 * fractions, the long side over the panel height, screen roll (clockwise
 * degrees), own turn (degrees, 180 = back), pitch (degrees, positive tips the
 * top away), the spotlight and, at a back stop, its rect.
 */
export type FocusKey = {
  kind: StageStopKind;
  face: 'front' | 'back';
  cx: number;
  cy: number;
  long: number;
  rz: number;
  ry: number;
  rx: number;
  on: number;
  rect?: SpotRect;
};

/**
 * Focus context for `focusPose` (stage-focus.ts).
 * - `index`: the focused pack's index in the attached set.
 * - `keys`: its stops in order (stop k >= 1 rests on `keys[k - 1]`).
 * - `panel`: the panel in host CSS px (keys are fractions of it).
 * - `backW`: 0..1, the back's readiness (back stops turn over as it arrives).
 * - `fit`: the drawn art height over the art box height (`object-fit:
 *   contain` of a pack wider than the box); keys size the drawn pack.
 */
export type FocusCtx = {
  index: number;
  anchorY: number;
  keys: readonly FocusKey[];
  panel: { w: number; h: number };
  backW?: number;
  fit?: number;
  /** The leave is under way: the neighbours come back over its last part. */
  leaving?: boolean;
};

/**
 * The focus declaration on `StageState.focusOn`. `term` and `spot` are the
 * focus maths, passed in so the runtime chunk does not carry them; `details`
 * is the back to print (null: the pack shows no back).
 */
export type StageFocusOn = {
  id: string;
  ctx: FocusCtx;
  term: FocusTerm;
  spot(focus: number, ctx: Readonly<FocusCtx>): { on: number; rect: SpotRect };
  details: PackBackDetails | null;
};

export type StageFocusRequest = {
  index: number;
  packId: string;
  back: PackBackDetails | null;
};

/** `withBack` is false whenever `canTurn` is. */
export type StageFocusDecl = {
  id: string;
  details: PackBackDetails | null;
  withBack: boolean;
};

export type StageBackStatus = 'none' | 'loading' | 'ready' | 'unavailable';
export type StageRenderBackStatus = 'none' | 'loading' | 'ready' | 'failed';

/** Spin back entries (10.5; the full-turn row, not wired: Ciao look ruling). */
export type StageSpinBack = { id: string; details: PackBackDetails | null };

/** What `Stage3dStage` gains with focus (next phase). */
export interface Stage3dStageFocusAdditions {
  values: { focus: Observable<number>; turn: Observable<number> };
  focusPack(
    r: StageFocusRequest | null,
    o?: { instant?: boolean },
  ): Promise<void>;
  updateBack(back: PackBackDetails | null): void;
  bindScroll(s: StageScrollSource): () => void;
  backStatus(): StageBackStatus;
  /** True on the render after an "All packs" arrival (stage-arrival.ts). */
  arrival: boolean;
}

/** What `StageRuntime` gains with focus (next phase). */
export interface StageRuntimeFocusAdditions {
  setFocus(f: StageFocusDecl | null): void;
}

// `poseAt` lives in `./stage-pose` (pure); re-exported so the contract path works too.
export { poseAt } from './stage-pose';

/** Signature of `poseAt` (implemented in `./stage-pose`). */
export type PoseAtFn = (
  s: StageState,
  i: number,
  l: StageLayout,
  desktop: boolean,
  soldOut: boolean,
  ctx?: Readonly<ComposeCtx>,
) => Pose;

/** The focus term, injected (so the first load never carries focus maths). */
export type FocusTerm = {
  pose(
    rest: Readonly<PoseBlock>,
    focus: number,
    turn: number,
    i: number,
    track: number,
    l: Readonly<StageLayout>,
    desktop: boolean,
    soldOut: boolean,
    ctx: Readonly<FocusCtx>,
  ): PoseBlock & { fx: number; fy: number };
  clampYaw(extraYaw: number, focus: number): number;
  opacity(
    focus: number,
    focused: boolean,
    ctx?: Readonly<Pick<FocusCtx, 'leaving'>> | null,
  ): number;
};

/** What `poseAt` and `stageOpacity` read beyond the state (all optional). */
export type ComposeCtx = {
  /** The spin context; without `spinPose` the spin term is skipped. */
  spin?: SpinCtx;
  /** The spin row's opacity rule, when loaded. */
  spinOpacity?: SpinOpacityFn;
  /** The focus context; only read while `focus > 0` and `focusTerm` is given. */
  focus?: FocusCtx | null;
  focusTerm?: FocusTerm;
  /** The composed pose (`stage-pose-compose.ts`), injected; without it only step 1's pose is drawn. */
  compose?: PoseAtFn;
};

/** The lazily loaded spin chunk (`stage-spin-kit.ts`), as the tiles see it. */
export type StageSpinKit = {
  compose: PoseAtFn;
  spinPose: SpinPoseFn;
  spinOpacity: SpinOpacityFn;
  copies(i: number, track: number, count: number, desktop: boolean): number[];
  /**
   * Poses a row's CSS tiles in the spin (the canvas draws the same poses);
   * false when the stage is not measured yet (the caller poses step 1).
   */
  paintTiles(
    row: HTMLElement,
    host: HTMLElement,
    packs: readonly { soldOut: boolean; ticket: boolean }[],
    state: StageState,
    cyArt: number,
  ): boolean;
};

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
    /** Step 2: the spin and the exit, mirrored into `state`. */
    spin: Observable<number>;
    exit: Observable<number>;
  };
  /** The flow shows the stage or sends it away (false: it sleeps and, after a while, lets its packs go). */
  show(on: boolean): void;
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
  /** ADDITION: `viewH`, the viewport height the spin row is projected against (default `h`). */
  resize(w: number, h: number, dpr: number, viewH?: number): void;
  /**
   * ADDITION: `centre` is the new list's starting track (its index space).
   * Packs already resident, or staged by `prefetch`, are carried by key.
   * `count` (step 2): the whole row's length, 3D or not (the spin row wraps
   * over it); default the list's.
   */
  setPacks(p: StageRuntimePack[] | null, centre?: number, count?: number): void;
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
