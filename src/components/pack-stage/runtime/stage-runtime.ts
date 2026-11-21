/**
 * Pack stage 3D runtime, async chunk `pack-stage-3d`. Only
 * `Stage3dProvider` reaches it, through a dynamic import.
 *
 * One renderer on the canvas it is given, one shared studio environment, one
 * catalogue model per resident pack (each pack has its own measured
 * geometry). Every pose comes from `poseAt`; this file only maps it into
 * world units (`placeModel`). Residency (`stage-residency`) decides what is
 * loaded; uploads go at most one texture per frame; `render` reports which
 * packs it actually drew, so the provider can hide their HTML pictures.
 *
 * It reads nothing from the DOM layout, the URL, cookies or storage: sizes and
 * the layout arrive through `resize` and `setLayout`.
 */
import * as THREE from 'three';

import { openPack3d, type Pack3d } from '@/components/pack-3d/catalog/build';
import type {
  PackFoilMaterial,
  PackFoilSettings,
} from '@/components/pack-3d/pack-material';
import type { PackModel } from '@/components/pack-3d/pack-model';
import type {
  ComposeCtx,
  FocusCtx,
  PackBackDetails,
  SpotRect,
  StageFocusOn,
  StageLayout,
  StageRuntime,
  StageRuntimeFailReason,
  StageRuntimeInput,
  StageRuntimePack,
  StageRuntimeStats,
  StageState,
} from '../contract';
import type { Capsule3dModel } from '@/components/pack-3d/capsule/build';
import { clamp01, poseAt, stageSpring } from '../stage-pose';
import { CAPSULE_LIMITS } from '../stage-capsule-lean';
import { LEAN } from '../stage-spin-math';
import {
  capsuleEstimateBytes,
  capsuleMaps,
  capsuleSharedBytes,
  openStageCapsule,
  paintCapsule,
  type StageCapsuleHandle,
} from './stage-capsule';
import {
  CIAO_ROW,
  ciaoCopies,
  ciaoOpacity,
  ciaoPose,
  wrapRow,
} from '../stage-spin';
import { composeOpacity, composePose } from '../stage-pose-compose';
import { focusBackWanted, lineupAppear, lineupResident } from '../stage-flow';
import {
  NO_PROMOTION,
  PROMOTE_MIN_DPR,
  halfSize,
  initialDirection,
  nextDirection,
  nextPromotion,
  planResidency,
  promotionPending,
  lapResidency,
  residencyConfig,
  textureBudgetBytes,
  textureBytes,
  type DirectionState,
  type PromotionState,
  type ResidentInfo,
} from './stage-residency';
import {
  MSAA_BELOW_DPR,
  createStageScene,
  dprCap,
  drawingBufferBytes,
  placeModel,
  stageBand,
  type StageScene,
} from './stage-scene';

/** Lite tier: no lacquer coat, no sheen (one cheaper program). Never alphaInterior. */
const LITE_FOIL: Partial<PackFoilSettings> = { clearcoat: 0, sheen: 0 };
/**
 * `dim` -> environment intensity: dim^1.146, so the sold-out 0.4 gives the
 * plan's x0.35 while colour and print glow take x0.4.
 */
const ENV_DIM_EXPONENT = Math.log(0.35) / Math.log(0.4);
const LITE_MAX_ANISOTROPY = 4;
/** A back that reaches the GPU after its pack got to a back stop turns over this long. */
const BACK_TURN_MS = 650;

type Res = 'half' | 'full';
type VariantState =
  'loading' | 'compiling' | 'built' | 'uploaded' | 'failed' | 'disposed';

type Variant = {
  res: Res;
  handle: Pack3d | StageCapsuleHandle;
  /** A sleeve's model. */
  model: PackModel | null;
  /** A capsule's model (a capsule slot has no `model`). */
  capsule: Capsule3dModel | null;
  bytes: number;
  state: VariantState;
  baseEnv: number;
  baseGlow: number;
  /**
   * The spin row's repeats of this pack (row-slot offset -> clone): each a
   * clone of the model sharing its geometry, textures and program, with its
   * own material object (own opacity and light). Freed with the variant.
   */
  copies: Map<number, THREE.Object3D>;
};

/** Clones a pack model for a repeat: geometry and textures shared, material cloned. */
function cloneForCopy(model: PackModel): THREE.Object3D {
  const c = model.clone();
  c.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const orig = mesh.material as THREE.MeshPhysicalMaterial;
    const m = orig.clone();
    // Material.copy leaves these out: the same closure and key give the same
    // program and the same uniform objects (no compile, no new texture).
    m.onBeforeCompile = orig.onBeforeCompile;
    m.customProgramCacheKey = orig.customProgramCacheKey;
    mesh.material = m;
    c.userData.mesh = mesh;
  });
  return c;
}

function disposeCopies(v: Variant) {
  for (const c of v.copies.values()) {
    c.removeFromParent();
    if (v.capsule) {
      // a capsule clone: its own materials, the model's geometry and textures
      (c as Capsule3dModel).dispose();
      continue;
    }
    const mesh = c.userData.mesh as THREE.Mesh | undefined;
    if (mesh) (mesh.material as THREE.Material).dispose();
  }
  v.copies.clear();
}

/** The object a variant draws (sleeve or capsule). */
const drawObject = (v: Variant): THREE.Object3D | null => v.model ?? v.capsule;

type Slot = {
  key: string;
  id: string;
  index: number;
  soldOut: boolean;
  /** A capsule (Poly): the capsule model, lean mode, no back. */
  capsule: boolean;
  width: number;
  height: number;
  half: Variant | null;
  full: Variant | null;
  halfFailed: boolean;
  fullFailed: boolean;
  lastNeeded: number;
  wantFull: boolean;
};

/** The focused pack's back, printed from the full plate on its drawn variant. */
type FocusBack = {
  slot: Slot;
  v: Variant;
  details: PackBackDetails;
  state: 'printing' | 'ready' | 'failed';
  /** GPU bytes once uploaded (charged to the uploaded total). */
  bytes: number;
  /** Peak CPU bytes the print held. */
  transient: number;
  /** Render time the back reached the GPU (NaN until the next frame). */
  readyAt: number;
};

/** QA: one pack drawn in the last frame (world units). */
export type DrawnPack = {
  id: string;
  index: number;
  opacity: number;
  x: number;
  y: number;
  z: number;
  scale: number;
  /** The frame time it was posed for. */
  at: number;
};

export type StageRuntimeDebug = {
  slots: {
    id: string;
    index: number;
    half: VariantState | null;
    full: VariantState | null;
    drawn: Res | null;
  }[];
  loads: number;
  disposals: number;
  /** Prefetched slots for the coming list (their half variant's state). */
  staged: string[];
  /** Current slots a pending prefetch keeps for the coming list. */
  kept: number;
  uploads: number;
  draws: number;
  pixelRatio: number;
  drawingBuffer: [number, number];
  samples: number;
  environmentBytes: number;
  bufferBytes: number;
  textureBytes: number;
  budgetBytes: number;
  /** Draw calls and triangles of the last frame drawn. */
  calls: number;
  triangles: number;
  failed: StageRuntimeFailReason | null;
  /** Spin row repeats drawn in the last frame, and whether the band covers the host. */
  copies: number;
  /** The packs drawn in the last frame (copies left out). */
  drawn: DrawnPack[];
  spinBand: boolean;
  bandH: number;
  /** The spotlight last set on the focused pack. */
  spot: { on: number; rect: SpotRect } | null;
  /** The focused back: state, GPU bytes, peak print bytes, canvas bytes held, turn weight. */
  focusBack: {
    id: string;
    state: FocusBack['state'];
    bytes: number;
    transient: number;
    canvasBytes: number;
    backW: number;
  } | null;
};

export type StageRuntimeBench = StageRuntime & {
  /** Optional start centre (the contract's prepare() takes none). */
  prepare(track?: number): Promise<void>;
  /** Bench and QA only. */
  debug(): StageRuntimeDebug;
  /** QA only: draw on the whole host (true) or the band (false). */
  debugFullCanvas(on: boolean): void;
};

function slotKey(p: StageRuntimePack): string {
  return `${p.id}|${p.art.frontHalf}|${p.art.front}`;
}

const macrotask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

export function createStageRuntime(
  input: StageRuntimeInput,
): StageRuntimeBench {
  const { canvas, tier, desktop } = input;
  const failCaveat = input.failIfMajorPerformanceCaveat ?? true;
  const cap = dprCap(tier);
  const config = residencyConfig(desktop);

  let stage: StageScene | null = null;
  let disposed = false;
  let failed: StageRuntimeFailReason | null = null;
  let finalInfo: StageRuntimeStats | null = null;

  let hostW = 0;
  let hostH = 0;
  let pixelRatio = 1;
  let sized = false;
  let bufferBytes = 0;
  let layout: StageLayout | null = null;
  let slots: Slot[] = [];
  let byIndex = new Map<number, Slot>();
  let packsKey = '';
  /**
   * `prefetch`: slots for the coming list (key -> slot at its COMING index),
   * loading and uploading while the old packs sink; `setPacks` adopts them.
   */
  let staged = new Map<string, Slot>();
  let stagedCentre = 0;
  /** Keys of current slots the coming list reuses: never dropped meanwhile. */
  let keep = new Set<string>();
  /** A switch is under way (prefetch to setPacks): no full-front promotion. */
  let switching = false;

  let direction: DirectionState | null = null;
  let promotion: PromotionState = { ...NO_PROMOTION };
  let lastTrack: number | null = null;
  let prepared: Promise<void> | null = null;
  let booting = true;

  /** The whole row's length (3D or not): the spin row wraps over it. */
  let rowCount = 0;
  /** The viewport height the spin row is projected against. */
  let viewH = 0;
  /** The canvas covers the whole host while the spin or its exit is under way. */
  let spinBand = false;
  /** Repeats (clones) drawn in the last frame. */
  let lastCopies = 0;
  /** QA: the packs drawn in the last frame, with their opacity and depth. */
  let lastDrawn: DrawnPack[] = [];
  /** The focused pack's back (one at a time). */
  let focusBack: FocusBack | null = null;
  let backW = 0;
  /** When each front was first drawable in a frame: a lineup pack fades in from it. */
  const firstShown = new WeakMap<Variant, number>();
  /** The material the spotlight was last set on. */
  let spotted: PackFoilMaterial | null = null;
  let lastFocusOn: StageFocusOn | null = null;
  let lastSpot: { on: number; rect: SpotRect } | null = null;

  let inflight = 0;
  let uploadedBytes = 0;
  let needsDraw = true;
  const STATE_KEYS = 13;
  const lastState = new Float64Array(STATE_KEYS).fill(Number.NaN);
  let lastLive: string[] = [];
  const seenShared = new Set<THREE.Texture>();

  const counters = { loads: 0, disposals: 0, uploads: 0, draws: 0 };
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();

  // --- failure -------------------------------------------------------------

  const fail = (reason: StageRuntimeFailReason) => {
    if (failed || disposed) return;
    failed = reason;
    try {
      input.onFail(reason);
    } catch {
      // the caller's handler must not break us
    }
  };

  const onContextLost = (e: Event) => {
    e.preventDefault();
    fail('context-lost');
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  const dead = () => disposed || failed !== null;

  // --- renderer (created on first need, so MSAA can follow the pixel ratio) --

  const ensureStage = (dpr: number): StageScene | null => {
    if (stage || dead()) return stage;
    try {
      stage = createStageScene({
        canvas,
        antialias: Math.min(dpr, cap) < MSAA_BELOW_DPR,
        failIfMajorPerformanceCaveat: failCaveat,
      });
    } catch {
      fail('error');
      return null;
    }
    return stage;
  };

  const fallbackDpr = () => {
    const d = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
    return typeof d === 'number' && d > 0 ? d : 1;
  };

  const updateBufferBytes = () => {
    if (!stage) return;
    const gl = stage.renderer.getContext();
    bufferBytes = drawingBufferBytes(
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      stage.samples,
    );
  };

  const budget = () =>
    textureBudgetBytes(desktop, bufferBytes + (stage?.environmentBytes ?? 0));

  // --- variants ---------------------------------------------------------------

  const estimateBytes = (slot: Slot, res: Res): number => {
    const v = res === 'half' ? slot.half : slot.full;
    if (v && v.bytes > 0) return v.bytes;
    if (slot.capsule) return capsuleEstimateBytes(slot.id, res);
    if (res === 'full') return textureBytes(slot.width, slot.height);
    const [w, h] = halfSize(slot.width, slot.height);
    return textureBytes(w, h);
  };

  /** Bytes a slot holds or is loading (estimates until a variant is built). */
  const slotBytes = (slot: Slot): number => {
    let b = 0;
    for (const v of [slot.half, slot.full]) {
      if (!v || v.state === 'disposed' || v.state === 'failed') continue;
      b += v.bytes > 0 ? v.bytes : estimateBytes(slot, v.res);
    }
    return b;
  };
  const stagedBytes = () => {
    let b = 0;
    for (const s of staged.values()) b += slotBytes(s);
    return b;
  };

  /** Frees the focused back (its GPU texture and canvas) and its charge. */
  const dropFocusBack = () => {
    const fb = focusBack;
    if (!fb) return;
    focusBack = null;
    backW = 0;
    if (fb.state === 'ready') uploadedBytes -= fb.bytes;
    if (fb.v.state !== 'disposed') fb.v.handle.hideBack();
    needsDraw = true;
  };

  /**
   * The back the focused pack needs: printed on the variant drawn for it (on
   * a promoted desktop pack, once the full front is up), reprinted when that
   * variant or the details change, freed when focus ends.
   */
  const syncFocusBack = (fo: StageFocusOn | null) => {
    const slot = fo
      ? slots.find((x) => x.id === fo.id && x.index === fo.ctx.index)
      : undefined;
    let target: Variant | null = null;
    // a capsule never shows a back
    if (fo?.details && slot && !slot.capsule) {
      target =
        slot.wantFull && !slot.fullFailed
          ? slot.full?.state === 'uploaded'
            ? slot.full
            : null
          : slot.half?.state === 'uploaded'
            ? slot.half
            : null;
    }
    const fb = focusBack;
    if (
      fb &&
      (!fo ||
        !fo.details ||
        fb.slot !== slot ||
        fb.details !== fo.details ||
        fb.v.state === 'disposed' ||
        (target !== null && fb.v !== target))
    )
      dropFocusBack();
    if (focusBack || !target || !fo?.details || !slot) return;
    const st = stage;
    if (!st) return;
    const next: FocusBack = {
      slot,
      v: target,
      details: fo.details,
      state: 'printing',
      bytes: 0,
      transient: 0,
      readyAt: Number.NaN,
    };
    focusBack = next;
    backW = 0;
    target.handle
      .showBack(fo.details, { plate: 'full', releaseCanvas: true })
      .then(
        (b) => {
          if (focusBack !== next || dead()) return;
          if (!b) {
            next.state = 'failed';
            return;
          }
          // on the GPU now (and the print canvas freed), not mid-pose later
          st.renderer.initTexture(b.texture);
          next.bytes = b.info.bytes;
          next.transient = b.transientBytes;
          next.state = 'ready';
          uploadedBytes += next.bytes;
          needsDraw = true;
        },
        () => {
          if (focusBack === next) next.state = 'failed';
        },
      );
  };

  const disposeVariant = (v: Variant | null) => {
    if (!v || v.state === 'disposed') return;
    if (focusBack?.v === v) dropFocusBack();
    if (v.state === 'uploaded') uploadedBytes -= v.bytes;
    v.state = 'disposed';
    disposeCopies(v);
    if (v.model) v.model.removeFromParent();
    if (v.capsule) v.capsule.removeFromParent();
    v.model = null;
    v.capsule = null;
    v.handle.dispose();
    counters.disposals++;
    needsDraw = true;
  };

  /** The focused back's bytes, an estimate (the full front's size) while it prints. */
  const focusBackBytes = (): number => {
    const fb = focusBack;
    if (!fb || fb.state === 'failed') return 0;
    return fb.state === 'ready'
      ? fb.bytes
      : textureBytes(fb.slot.width, fb.slot.height);
  };

  const disposeSlot = (slot: Slot) => {
    disposeVariant(slot.half);
    disposeVariant(slot.full);
    slot.half = null;
    slot.full = null;
  };

  const startVariant = (slot: Slot, res: Res): Variant | null => {
    const st = stage;
    if (!st || dead()) return null;
    const maxAniso = st.renderer.capabilities.getMaxAnisotropy();
    const anisotropy =
      tier === 'lite' ? Math.min(maxAniso, LITE_MAX_ANISOTROPY) : maxAniso;
    // The model entry point dispatches on shape: a capsule's own module, or
    // the sleeve catalogue.
    const capsuleHandle = slot.capsule
      ? openStageCapsule(slot.id, res, anisotropy)
      : null;
    const sleeveHandle = slot.capsule
      ? null
      : openPack3d(slot.id, {
          resolution: res,
          envMap: st.environment.texture,
          anisotropy,
          foil: tier === 'lite' ? LITE_FOIL : undefined,
        });
    const handle = capsuleHandle ?? sleeveHandle;
    if (!handle) {
      if (res === 'half') slot.halfFailed = true;
      else slot.fullFailed = true;
      return null;
    }
    const v: Variant = {
      res,
      handle,
      model: null,
      capsule: null,
      bytes: 0,
      state: 'loading',
      baseEnv: 1,
      baseGlow: 0,
      copies: new Map(),
    };
    counters.loads++;
    inflight++;
    const failVariant = () => {
      if (v.state === 'disposed') return;
      v.state = 'failed';
      if (res === 'half') slot.halfFailed = true;
      else slot.fullFailed = true;
      v.handle.dispose();
    };
    const built: Promise<THREE.Object3D> = capsuleHandle
      ? capsuleHandle.model().then((model) => {
          if (v.state === 'loading' && !dead()) v.capsule = model;
          return model;
        })
      : sleeveHandle!.model().then((model) => {
          if (v.state !== 'loading' || dead()) return model;
          const material = model.material;
          // Fade by slot opacity without a second program: transparent from
          // the start (at opacity 1 it draws exactly as an opaque pack).
          material.transparent = true;
          v.baseEnv = material.envMapIntensity;
          v.baseGlow = material.emissiveIntensity;
          v.model = model;
          return model;
        });
    built
      .then(
        async (model) => {
          if (v.state !== 'loading' || dead()) return;
          v.bytes = handle.textures().reduce((s, t) => s + t.bytes, 0);
          v.state = 'compiling';
          // Programs are shared, so this is instant after the first pack;
          // either way no frame ever compiles a shader synchronously.
          await st.renderer.compileAsync(model, st.camera, st.scene);
          if (v.state !== 'compiling' || dead()) return;
          v.state = 'built';
          needsDraw = true;
        },
        () => failVariant(),
      )
      .catch(() => {
        // a thrown error in our own handler, not a missing picture
        if (!disposed && v.state !== 'disposed') fail('error');
      })
      .finally(() => {
        inflight--;
      });
    return v;
  };

  /** Uploads one variant's front texture and puts it in the scene. */
  const upload = (v: Variant) => {
    const st = stage;
    const model = drawObject(v);
    if (!st || !model || v.state !== 'built') return;
    if (v.capsule) {
      // a capsule's textures are small (matcaps, its contents): all at once
      for (const t of capsuleMaps(v.capsule)) st.renderer.initTexture(t);
    } else {
      const map = v.model?.material.map;
      if (map) st.renderer.initTexture(map);
    }
    model.visible = false;
    st.scene.add(model);
    v.state = 'uploaded';
    uploadedBytes += v.bytes;
    counters.uploads++;
    needsDraw = true;
  };

  // --- residency ---------------------------------------------------------------

  /**
   * `spinRow`: the lineup row is formed or forming. Every pack whose wrapped row
   * slot is within the row's reach (desktop 6, phone 2, plus the fading one)
   * is needed, all at half resolution, no full-front promotion. The row's
   * slots do not move during the spin (no travel, the track is locked), so
   * this set holds still through a move; residency maps each pack to its
   * wrapped index so the plan's distances are row distances.
   */
  const applyPlan = (
    track: number,
    now: number,
    spinRow = false,
    promote = !spinRow,
    only = false,
  ) => {
    if (slots.length === 0) return;
    const n = Math.max(rowCount, slots.length);
    const wrapped = (i: number) =>
      spinRow && n > 1 ? track + wrapRow(i - track, n) : i;
    const fromWrapped = new Map<number, Slot>();
    for (const s of slots) fromWrapped.set(wrapped(s.index), s);
    const resident = new Map<number, ResidentInfo>();
    for (const s of slots)
      if (s.half || s.full)
        resident.set(wrapped(s.index), { lastNeeded: s.lastNeeded });
    const reach = desktop ? CIAO_ROW.reachDesktop : CIAO_ROW.reachPhone;
    const plan = planResidency({
      indices: slots.filter((s) => !s.halfFailed).map((s) => wrapped(s.index)),
      track,
      direction: spinRow || only ? 0 : (direction?.dir ?? 0),
      config: only
        ? lapResidency(config)
        : spinRow
          ? {
              ...config,
              reach,
              disposeAt: reach + 1,
              maxResident: Math.max(config.maxResident, slots.length),
            }
          : config,
      promote: promote ? promotion.index : null,
      // A prefetch for the coming list holds its share of the budget.
      budgetBytes: Math.max(0, budget() - stagedBytes() - focusBackBytes()),
      bytes: (i, res) => {
        const s = fromWrapped.get(i);
        return s ? estimateBytes(s, res) : 0;
      },
      resident,
      now,
    });
    const want = new Map<number, { full: boolean }>();
    for (const [w, e] of plan.want) {
      const s = fromWrapped.get(w);
      if (s) want.set(s.index, e);
    }
    for (const w of plan.stamp) {
      const s = fromWrapped.get(w);
      if (s) s.lastNeeded = now;
    }
    // Drop first, then load, so the budget is never exceeded on the way.
    for (const s of slots) {
      const w = want.get(s.index);
      s.wantFull = w?.full === true;
      if (!w) {
        // The coming list reuses it: keep its texture through the switch.
        if (keep.has(s.key)) continue;
        disposeSlot(s);
        continue;
      }
      if (!w.full && s.full) {
        disposeVariant(s.full);
        s.full = null;
      }
    }
    for (const s of slots) {
      const w = want.get(s.index);
      if (!w) continue;
      if (!s.half && !s.halfFailed) s.half = startVariant(s, 'half');
      if (w.full && !s.full && !s.fullFailed && s.half?.state === 'uploaded')
        s.full = startVariant(s, 'full');
    }
  };

  /** The next variant to upload: wanted, built, nearest the centre, half first. */
  const nextUpload = (track: number, spinRow = false): Variant | null => {
    let best: Variant | null = null;
    let bestScore = Infinity;
    const n = Math.max(rowCount, slots.length);
    const consider = (s: Slot, centre: number, row = false) => {
      for (const v of [s.half, s.full]) {
        if (!v || v.state !== 'built') continue;
        const dist =
          row && n > 1 ? wrapRow(s.index - centre, n) : s.index - centre;
        const score = Math.abs(dist) * 2 + (v.res === 'full' ? 1 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = v;
        }
      }
    };
    for (const s of slots) consider(s, track, spinRow);
    // The coming list's packs, by distance from ITS centre.
    for (const s of staged.values()) consider(s, stagedCentre);
    return best;
  };

  const drawnVariant = (s: Slot): Variant | null => {
    if (s.wantFull && s.full?.state === 'uploaded') return s.full;
    if (s.half?.state === 'uploaded') return s.half;
    if (s.full?.state === 'uploaded') return s.full;
    return null;
  };

  const defaultCentre = (): number => {
    if (lastTrack !== null) return lastTrack;
    const inStock = slots.find((s) => !s.soldOut) ?? slots[0];
    return inStock ? inStock.index : 0;
  };

  // --- the runtime -------------------------------------------------------------

  const resize = (w: number, h: number, dpr: number, vh?: number) => {
    if (dead()) return;
    const st = ensureStage(dpr);
    if (!st) return;
    sized = true;
    hostW = Math.max(0, w);
    hostH = Math.max(0, h);
    viewH = vh && vh > 0 ? vh : hostH;
    pixelRatio = Math.max(0.5, Math.min(dpr > 0 ? dpr : 1, cap));
    applyBand();
  };

  /**
   * The canvas covers only the band of the host where a pack can be seen (the
   * carousel row, with room for the float-in and the sink below it), not the
   * whole stage section: the drawing buffer is most of the GPU memory, above
   * all at DPR 2. The camera still frames the WHOLE host (setViewOffset
   * renders the band's slice of that view), so every pose, the CSS
   * perspective origin and the pixel-to-world mapping are unchanged.
   */
  let band = { y: 0, h: 0 };
  /** QA only (`__packStage.fullCanvas`): the whole host, as before the band. */
  let fullCanvas = false;
  // The spin row and its exit reach every part of the panel (the row climbs
  // to the right and leaves through the top): while either runs, the whole
  // host. Switched once as the spin leaves 0 and once as it comes back.
  const bandFor = () =>
    fullCanvas || spinBand
      ? { y: 0, h: Math.round(hostH) }
      : stageBand(hostH, layout);
  const applyBand = () => {
    const st = stage;
    if (!st || dead()) return;
    if (hostW > 0 && hostH > 0) {
      band = bandFor();
      st.renderer.setPixelRatio(pixelRatio);
      st.renderer.setSize(hostW, band.h, false);
      canvas.style.top = `${band.y}px`;
      canvas.style.bottom = 'auto';
      canvas.style.height = `${band.h}px`;
      st.camera.aspect = hostW / hostH;
      st.camera.setViewOffset(hostW, hostH, 0, band.y, hostW, band.h);
      st.camera.updateProjectionMatrix();
    }
    updateBufferBytes();
    needsDraw = true;
  };

  const newSlot = (p: StageRuntimePack): Slot => ({
    key: slotKey(p),
    id: p.id,
    index: p.index,
    soldOut: p.soldOut,
    capsule: p.art.shape === 'capsule',
    width: p.art.width,
    height: p.art.height,
    half: null,
    full: null,
    halfFailed: false,
    fullFailed: false,
    lastNeeded: Number.NEGATIVE_INFINITY,
    wantFull: false,
  });

  const holds = (s: Slot) => s.half !== null || s.full !== null;

  /** Drops whatever a prefetch staged and nothing adopted. */
  const dropStaged = () => {
    for (const s of staged.values()) disposeSlot(s);
    staged = new Map();
    keep = new Set();
    switching = false;
  };

  const prefetch = (list: StageRuntimePack[] | null, centre: number) => {
    if (dead() || !stage) return;
    const want = (list ?? [])
      .filter((p) => Math.abs(p.index - centre) < config.reach + 1)
      .sort(
        (a, b) =>
          Math.abs(a.index - centre) - Math.abs(b.index - centre) ||
          a.index - b.index,
      );
    const current = new Map(slots.map((s) => [s.key, s]));
    const nextKeep = new Set<string>();
    const nextStaged = new Map<string, Slot>();
    const wantKeys = new Set(want.map(slotKey));
    // A newer tap supersedes an older one: drop what it no longer wants
    // first, so the budget below is what is really left.
    for (const [k, s] of staged) if (!wantKeys.has(k)) disposeSlot(s);
    staged = new Map([...staged].filter(([k]) => wantKeys.has(k)));
    switching = want.length > 0;
    if (switching) {
      // The sinking centre gives back its full front (retina desktop): the
      // coming packs need the room more, and nobody sees the sharper texture
      // on a pack that is leaving. Promotion resumes once the new row lands.
      for (const s of slots) {
        if (!s.full) continue;
        disposeVariant(s.full);
        s.full = null;
        s.wantFull = false;
      }
      promotion = { ...NO_PROMOTION };
    }
    let room = Math.max(0, budget() - uploadedOrLoading());
    if (!booting) {
      for (const p of want) {
        const k = slotKey(p);
        const cur = current.get(k);
        if (cur && holds(cur)) {
          nextKeep.add(k); // resident already: carried by setPacks
          continue;
        }
        const had = staged.get(k);
        if (had) {
          had.index = p.index;
          had.soldOut = p.soldOut;
          nextStaged.set(k, had);
          continue;
        }
        const s = newSlot(p);
        const cost = estimateBytes(s, 'half');
        if (cost > room) break; // nearest first: the rest waits for setPacks
        s.half = startVariant(s, 'half');
        if (!s.half) continue;
        room -= cost;
        nextStaged.set(k, s);
      }
    }
    for (const [k, s] of staged) if (!nextStaged.has(k)) disposeSlot(s);
    staged = nextStaged;
    stagedCentre = centre;
    keep = nextKeep;
  };

  /** Every byte held or on its way, current list and staged. */
  const uploadedOrLoading = () => {
    let b = 0;
    for (const s of slots) b += slotBytes(s);
    return b + stagedBytes();
  };

  const setPacks = (
    list: StageRuntimePack[] | null,
    centre?: number,
    count?: number,
  ) => {
    if (dead()) return;
    const next = list ?? [];
    rowCount = typeof count === 'number' && count > 0 ? count : next.length;
    const key = next
      .map((p) => `${slotKey(p)}@${p.index}${p.soldOut ? 's' : ''}`)
      .join(',');
    if (key === packsKey) {
      dropStaged();
      return;
    }
    packsKey = key;
    const old = new Map(slots.map((s) => [s.key, s]));
    const oldPromoted =
      promotion.index !== null
        ? (byIndex.get(promotion.index)?.key ?? null)
        : null;
    const fresh: Slot[] = [];
    for (const p of next) {
      const k = slotKey(p);
      let prev = old.get(k) ?? null;
      const st = staged.get(k) ?? null;
      if (st) {
        staged.delete(k);
        // Keep whichever holds a texture (a resident pack wins).
        if (prev && holds(prev)) disposeSlot(st);
        else {
          if (prev) disposeSlot(prev);
          prev = st;
        }
      }
      if (prev) {
        old.delete(k);
        prev.index = p.index;
        prev.soldOut = p.soldOut;
        fresh.push(prev);
        continue;
      }
      fresh.push(newSlot(p));
    }
    const carried = fresh.some(holds);
    for (const s of old.values()) disposeSlot(s);
    dropStaged();
    slots = fresh;
    byIndex = new Map(fresh.map((s) => [s.index, s]));
    // A carried promoted pack stays promoted (no full-front reload).
    const promotedNow = oldPromoted
      ? (fresh.find((s) => s.key === oldPromoted)?.index ?? null)
      : null;
    promotion =
      promotedNow === null
        ? { ...NO_PROMOTION }
        : { index: promotedNow, since: null, lastTrack: null };
    needsDraw = true;
    if (typeof centre === 'number') {
      // The new list's own index space.
      lastTrack = centre;
      direction = initialDirection(centre);
    } else if (!carried && next.length > 0 && old.size > 0) {
      // A different list (category switch): its track restarts, so do not
      // centre the first loads on the old list's position.
      lastTrack = null;
      direction = null;
    }
    if (stage && !dead() && old.size > 0) {
      // The provider may stop rendering now (Poly tab, released while
      // hidden): never leave the old packs' last frame on the canvas.
      const st = stage;
      st.renderer.setRenderTarget(null);
      st.renderer.clear();
      lastLive = [];
      lastState.fill(Number.NaN);
    }
    if (!booting && stage) {
      // A later list (category switch, reload after release): start the
      // centre +-1 now; render() takes it from there.
      applyPlan(defaultCentre(), 0);
    }
  };

  const setLayout = (l: StageLayout) => {
    if (dead()) return;
    layout = { cx: l.cx, cy: l.cy, step: l.step, artH: l.artH, artW: l.artW };
    const next = bandFor();
    if (next.y !== band.y || next.h !== band.h) applyBand();
    needsDraw = true;
  };

  const prepare = (track?: number): Promise<void> => {
    prepared ??= (async () => {
      const st = ensureStage(sized ? pixelRatio : fallbackDpr());
      if (!st || dead()) return;
      const centre = typeof track === 'number' ? track : defaultCentre();
      lastTrack = centre;
      direction = initialDirection(centre);
      // Boot set: centre +-1 only (the rest loads frame by frame).
      const boot = planResidency({
        indices: slots.filter((s) => !s.halfFailed).map((s) => s.index),
        track: centre,
        direction: 0,
        config: { ...config, reach: 1 },
        promote: null,
        budgetBytes: budget(),
        bytes: (i, res) => {
          const s = byIndex.get(i);
          return s ? estimateBytes(s, res) : 0;
        },
        resident: new Map(),
        now: 0,
      });
      const started: Variant[] = [];
      for (const s of slots) {
        if (!boot.want.has(s.index)) continue;
        s.half ??= startVariant(s, 'half');
        if (s.half) started.push(s.half);
      }
      // Wait for every boot pack to build and compile (or fail on its own).
      while (
        !dead() &&
        started.some((v) => v.state === 'loading' || v.state === 'compiling')
      )
        await macrotask();
      if (dead()) return;
      // Each boot model went through renderer.compileAsync(model, camera,
      // scene) as it built, so no shader compiles at float-in.
      // Upload before the loader leaves, one texture per task.
      started.sort((a, b) => a.bytes - b.bytes);
      for (const v of started) {
        if (dead()) return;
        if (v.state !== 'built') continue;
        upload(v);
        await macrotask();
      }
      booting = false;
      needsDraw = true;
    })().catch((e: unknown) => {
      booting = false;
      if (!disposed) fail('error');
      throw e;
    });
    return prepared;
  };

  const stateChanged = (s: Readonly<StageState>): boolean => {
    const v = [
      s.intro,
      s.track,
      s.swap,
      s.pointerX,
      s.pointerY,
      s.idle,
      s.focus,
      s.turn,
      s.spin,
      s.exit,
      s.lap ? s.lap.rise : -1,
      s.lap ? s.lap.ret : -1,
      (s.lap?.free ? 1 : 0) + (s.lap?.trim ? 2 : 0),
    ];
    let changed = false;
    for (let i = 0; i < STATE_KEYS; i++) {
      if (lastState[i] !== v[i]) {
        lastState[i] = v[i] ?? 0;
        changed = true;
      }
    }
    return changed;
  };

  const render = (
    s: Readonly<StageState>,
    now: number,
  ): { live: string[]; wantsFrame: boolean } => {
    const st = stage;
    if (dead() || !st) return { live: [], wantsFrame: false };
    try {
      const track = s.track;
      lastTrack = track;
      direction = direction
        ? nextDirection(direction, track)
        : initialDirection(track);
      // the end of the lap: the row at rest, no focus
      // and no lineup (rise, Return, Last, the wrap's lock); the free span
      // draws nothing
      // and keeps the lineup's own residency, trimmed to the chosen pack
      // away from its ends (lap.trim)
      const lap = s.lap ?? null;
      const rowLap = lap !== null && !lap.free;
      const fo = !rowLap && s.focus > 0 ? (s.focusOn ?? null) : null;
      // the row (the packshot lineup), or the focused pack's hand-off into the
      // lineup and its exit: the row's residency and
      // repeats. Up to Closing + 0.5 the focused pack keeps its back and its
      // promoted front; past it both are let go for the lineup's fronts.
      const spinRow = !rowLap && (s.spin > 0 || s.exit > 0);
      // the row's residency from the rest on Closing on, so no lineup front
      // is uploaded mid-move (it would pop in at the fade it had reached)
      const rowPlan =
        !rowLap &&
        lineupResident({
          focus: s.focus,
          stops: fo?.ctx.keys.length ?? 0,
          spin: s.spin,
          exit: s.exit,
        });
      const keepFocus = fo !== null && focusBackWanted(s.spin) && !(s.exit > 0);
      // the focused pack's stops reach the whole panel too
      const wide = spinRow || fo !== null;
      if (wide !== spinBand) {
        spinBand = wide;
        applyBand();
      }
      const promoteOn =
        desktop &&
        tier === 'full' &&
        pixelRatio >= PROMOTE_MIN_DPR &&
        !switching &&
        !lap?.trim &&
        (!rowPlan || keepFocus);
      promotion = nextPromotion(promotion, track, now, promoteOn);
      if (!booting)
        applyPlan(
          track,
          now,
          rowPlan,
          (!rowPlan || keepFocus) && !lap?.trim,
          !!lap?.trim,
        );
      const next = booting ? null : nextUpload(track, rowPlan);
      if (next) upload(next);

      if (fo !== lastFocusOn) {
        lastFocusOn = fo;
        needsDraw = true;
      }
      if (!booting) syncFocusBack(fo && (!rowPlan || keepFocus) ? fo : null);
      const fb = focusBack;
      let turning = false;
      let appearing = false;
      if (fb?.state === 'ready') {
        if (Number.isNaN(fb.readyAt)) fb.readyAt = now;
        const t = clamp01((now - fb.readyAt) / BACK_TURN_MS);
        const w = t * t * (3 - 2 * t);
        if (w !== backW) {
          backW = w;
          needsDraw = true;
        }
        turning = w < 1;
      } else if (backW !== 0) {
        backW = 0;
        needsDraw = true;
      }
      if (!fo && spotted) {
        spotted.setSpot({ on: 0, rect: { x0: 0, y0: 0, x1: 1, y1: 1 } });
        spotted = null;
        needsDraw = true;
      }

      const moved = stateChanged(s);
      const canDraw = layout !== null && hostW > 0 && hostH > 0;
      let live = lastLive;
      if (canDraw && (moved || needsDraw)) {
        const l = layout as StageLayout;
        live = [];
        st.camera.updateMatrixWorld();
        projScreen.multiplyMatrices(
          st.camera.projectionMatrix,
          st.camera.matrixWorldInverse,
        );
        frustum.setFromProjectionMatrix(projScreen);
        const n = Math.max(rowCount, slots.length);
        const panel = {
          w: hostW,
          h: hostH,
          anchorY: hostH > 0 ? l.cy / hostH : 0.5,
          viewH: viewH || hostH,
        };
        const rise = 1 - stageSpring(clamp01(s.swap));
        let copiesDrawn = 0;
        const drawnNow: typeof lastDrawn = [];
        for (const slot of slots) {
          const shown = drawnVariant(slot);
          for (const v of [slot.half, slot.full]) {
            if (!v || v === shown) continue;
            const o = drawObject(v);
            if (o) o.visible = false;
            for (const c of v.copies.values()) c.visible = false;
          }
          const model = shown ? drawObject(shown) : null;
          if (!shown || !model) continue;
          // in the hand-off, the lineup and its exit, a pack whose front has
          // only just come (back) fades in instead of cutting in
          let since = firstShown.get(shown);
          if (since === undefined) {
            since = now;
            firstShown.set(shown, since);
          }
          // and in the lap (the rise, Return, the wrap's lock), a pack staged
          // again after the free span fades in beside the chosen one
          const appear =
            (spinRow && fo !== null && slot.index !== fo.ctx.index) ||
            (rowLap && slot.index !== Math.round(track))
              ? lineupAppear(now - since)
              : 1;
          if (appear < 1) appearing = true;
          // One context for the CSS tiles and the canvas: the lineup row, its
          // exit, the row's own fade (stage-pose composes the rest).
          const ctx: ComposeCtx = {
            spin: {
              count: n,
              turn: 0,
              lean: slot.capsule ? CAPSULE_LIMITS.yaw : LEAN,
              spinPose: ciaoPose,
              soldOut: slot.soldOut,
              exit: s.exit,
              panel,
              capsule: slot.capsule,
            },
            spinOpacity: ciaoOpacity,
            compose: composePose,
          };
          // The picture is `object-fit: contain` in the art box: a pack wider
          // than the box draws shorter than artH, so the model does too.
          const fit =
            l.artW && slot.width > 0 && slot.height > 0
              ? Math.min(1, l.artW / l.artH / (slot.width / slot.height))
              : 1;
          const focused = fo !== null && slot.index === fo.ctx.index;
          let fctx: FocusCtx | null = null;
          if (fo) {
            fctx = {
              ...fo.ctx,
              panel: { w: hostW, h: hostH },
              anchorY: panel.anchorY,
              backW: fo.details ? backW : 0,
              fit,
            };
            ctx.focus = fctx;
            ctx.focusTerm = fo.term;
          }
          const fitted = fit < 1 ? { ...l, artH: l.artH * fit } : l;
          const slotX = l.cx + (slot.index - track) * l.step;
          const paint = (
            obj: THREE.Object3D,
            pose: ReturnType<typeof poseAt>,
            opacity: number,
          ) => {
            // the pose is in layout px; the fitted art height only scales it
            placeModel(obj, pose, slotX, fitted, hostW, hostH);
            if (shown.capsule) {
              paintCapsule(obj as Capsule3dModel, pose, opacity);
            } else {
              const m = (
                obj === model
                  ? shown.model?.material
                  : (obj.userData.mesh as THREE.Mesh).material
              ) as THREE.MeshPhysicalMaterial;
              m.opacity = opacity;
              m.color.setScalar(pose.dim);
              m.emissiveIntensity = shown.baseGlow * pose.dim;
              m.envMapIntensity =
                shown.baseEnv *
                Math.pow(Math.max(0, pose.dim), ENV_DIM_EXPONENT);
            }
            obj.visible = true;
            obj.updateMatrixWorld(true);
          };
          // The spin row's repeats (a short set is repeated out to 24 cans): clones.
          const offsets = spinRow
            ? ciaoCopies(slot.index, track, n, desktop).filter((o) => o !== 0)
            : [];
          for (const [o, c] of shown.copies)
            if (!offsets.includes(o)) c.visible = false;
          for (const o of offsets) {
            const op =
              composeOpacity(s, slot.index, desktop, n, ctx, o) * rise * appear;
            const have = shown.copies.get(o);
            if (!(op > 0)) {
              if (have) have.visible = false;
              continue;
            }
            let c = have;
            if (!c) {
              c = shown.capsule
                ? shown.capsule.clone()
                : cloneForCopy(shown.model!);
              shown.copies.set(o, c);
              st.scene.add(c);
            }
            const cpose = poseAt(s, slot.index, l, desktop, slot.soldOut, {
              ...ctx,
              spin: { ...ctx.spin!, copy: o },
            });
            paint(c, cpose, op);
            copiesDrawn++;
          }
          // The same fade as the CSS tiles: reach (the row's, in the spin) and the category switch.
          const opacity =
            composeOpacity(s, slot.index, desktop, n, ctx) * appear;
          if (opacity <= 0) {
            model.visible = false;
            continue;
          }
          const pose = poseAt(s, slot.index, l, desktop, slot.soldOut, ctx);
          paint(model, pose, opacity);
          drawnNow.push({
            id: slot.id,
            index: slot.index,
            opacity,
            x: model.position.x,
            y: model.position.y,
            z: model.position.z,
            scale: model.scale.x,
            at: now,
          });
          const sleeve = shown.model;
          if (focused && fo && fctx && sleeve) {
            const sp = fo.spot(s.focus, fctx);
            if (spotted && spotted !== sleeve.material)
              spotted.setSpot({ on: 0, rect: sp.rect });
            sleeve.material.setSpot(sp);
            spotted = sleeve.material;
            lastSpot = sp;
          }
          // a capsule has no spotlight: the last one set goes out
          if (focused && !sleeve && spotted) {
            spotted.setSpot({ on: 0, rect: { x0: 0, y0: 0, x1: 1, y1: 1 } });
            spotted = null;
          }
          const bounds = sleeve ? sleeve.mesh : shown.capsule?.meshes.cap;
          if (bounds && frustum.intersectsObject(bounds)) live.push(slot.id);
        }
        lastCopies = copiesDrawn;
        lastDrawn = drawnNow;
        st.renderer.render(st.scene, st.camera);
        if (seenShared.size === 0) sharedTextures(st);
        counters.draws++;
        needsDraw = false;
        lastLive = live;
      } else if (!canDraw) {
        live = [];
        lastLive = live;
      }

      const pending =
        inflight > 0 ||
        [...staged.values()].some((sl) => sl.half?.state === 'built') ||
        slots.some(
          (sl) =>
            sl.half?.state === 'built' ||
            sl.full?.state === 'built' ||
            (sl.wantFull && sl.full?.state !== 'uploaded' && !sl.fullFailed),
        ) ||
        promotionPending(promotion, track, promoteOn) ||
        focusBack?.state === 'printing' ||
        turning ||
        appearing ||
        (needsDraw && canDraw);
      return { live: [...live], wantsFrame: pending };
    } catch {
      fail('error');
      return { live: [], wantsFrame: false };
    }
  };

  /** The capsules' shared logo mask, once per resolution an uploaded capsule uses. */
  const capsuleShared = (): number => {
    const res = new Set<Res>();
    for (const s of [...slots, ...staged.values()])
      for (const v of [s.half, s.full])
        if (v?.capsule && v.state === 'uploaded') res.add(v.res);
    let b = 0;
    for (const r of res) b += capsuleSharedBytes(r);
    return b;
  };

  const stats = (): StageRuntimeStats => {
    if (finalInfo) return finalInfo;
    const info = stage?.renderer.info;
    return {
      textures: info?.memory.textures ?? 0,
      geometries: info?.memory.geometries ?? 0,
      programs: info?.programs?.length ?? 0,
      // the focused back's print canvas counts until the upload frees it
      gpuBytesEstimate: stage
        ? bufferBytes +
          stage.environmentBytes +
          uploadedBytes +
          capsuleShared() +
          (focusBack && focusBack.v.state !== 'disposed'
            ? focusBack.v.handle.canvasBytes()
            : 0)
        : 0,
    };
  };

  const debug = (): StageRuntimeDebug => {
    const gl = stage?.renderer.getContext();
    return {
      slots: slots.map((s) => {
        const d = drawnVariant(s);
        return {
          id: s.id,
          index: s.index,
          half: s.half?.state ?? (s.halfFailed ? 'failed' : null),
          full: s.full?.state ?? (s.fullFailed ? 'failed' : null),
          drawn: d ? d.res : null,
        };
      }),
      ...counters,
      staged: [...staged.values()].map((s) => s.half?.state ?? 'none'),
      kept: keep.size,
      pixelRatio,
      drawingBuffer: gl
        ? [gl.drawingBufferWidth, gl.drawingBufferHeight]
        : [0, 0],
      samples: stage?.samples ?? 0,
      environmentBytes: stage?.environmentBytes ?? 0,
      bufferBytes,
      textureBytes: uploadedBytes + capsuleShared(),
      budgetBytes: budget(),
      calls: stage?.renderer.info.render.calls ?? 0,
      triangles: stage?.renderer.info.render.triangles ?? 0,
      failed,
      copies: lastCopies,
      drawn: lastDrawn,
      spinBand,
      bandH: band.h,
      spot: lastSpot,
      focusBack: focusBack
        ? {
            id: focusBack.slot.id,
            state: focusBack.state,
            bytes: focusBack.bytes,
            transient: focusBack.transient,
            canvasBytes:
              focusBack.v.state === 'disposed'
                ? 0
                : focusBack.v.handle.canvasBytes(),
            backW,
          }
        : null,
    };
  };

  /** Renderer-owned textures bound to our materials (the DFG LUT). */
  const sharedTextures = (st: StageScene): THREE.Texture[] => {
    const props = (
      st.renderer as unknown as {
        properties?: {
          get(o: object): { uniforms?: Record<string, { value?: unknown }> };
        };
      }
    ).properties;
    const out = seenShared;
    if (!props) return [];
    for (const s of slots) {
      for (const v of [s.half, s.full]) {
        const m = v?.model?.material;
        if (!m) continue;
        const lut = props.get(m).uniforms?.dfgLUT?.value;
        if (lut instanceof THREE.Texture) out.add(lut);
      }
    }
    return [...out];
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('webglcontextlost', onContextLost);
    const st = stage;
    const shared = st ? sharedTextures(st) : [];
    dropFocusBack();
    for (const s of slots) disposeSlot(s);
    dropStaged();
    slots = [];
    byIndex = new Map();
    if (st) {
      st.environment.dispose();
      // three's physical-material DFG lookup table is a module-wide 16x16
      // texture the renderer never frees; releasing our binding re-uploads it
      // lazily for any other renderer that uses it.
      for (const t of shared) t.dispose();
      st.scene.clear();
      const info = st.renderer.info;
      finalInfo = {
        textures: info.memory.textures,
        geometries: info.memory.geometries,
        programs: info.programs?.length ?? 0,
        gpuBytesEstimate: 0,
      };
      st.renderer.dispose();
    } else {
      finalInfo = {
        textures: 0,
        geometries: 0,
        programs: 0,
        gpuBytesEstimate: 0,
      };
    }
    // No forceContextLoss(): the canvas stays reusable (the provider removes it).
  };

  return {
    resize,
    setPacks,
    prefetch,
    setLayout,
    prepare,
    render,
    stats,
    dispose,
    debug,
    debugFullCanvas: (on: boolean) => {
      fullCanvas = on;
      applyBand();
    },
  };
}
