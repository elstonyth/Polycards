/**
 * Pack stage 3D runtime (plan section 4), async chunk `pack-stage-3d`. Only
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
import type { PackFoilSettings } from '@/components/pack-3d/pack-material';
import type { PackModel } from '@/components/pack-3d/pack-model';
import type {
  StageLayout,
  StageRuntime,
  StageRuntimeFailReason,
  StageRuntimeInput,
  StageRuntimePack,
  StageRuntimeStats,
  StageState,
} from '../contract';
import { poseAt, slotOpacity } from '../stage-pose';
import {
  NO_PROMOTION,
  PROMOTE_MIN_DPR,
  halfSize,
  initialDirection,
  nextDirection,
  nextPromotion,
  planResidency,
  promotionPending,
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

type Res = 'half' | 'full';
type VariantState =
  | 'loading'
  | 'compiling'
  | 'built'
  | 'uploaded'
  | 'failed'
  | 'disposed';

type Variant = {
  res: Res;
  handle: Pack3d;
  model: PackModel | null;
  bytes: number;
  state: VariantState;
  baseEnv: number;
  baseGlow: number;
};

type Slot = {
  key: string;
  id: string;
  index: number;
  soldOut: boolean;
  width: number;
  height: number;
  half: Variant | null;
  full: Variant | null;
  halfFailed: boolean;
  fullFailed: boolean;
  lastNeeded: number;
  wantFull: boolean;
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
  uploads: number;
  draws: number;
  pixelRatio: number;
  drawingBuffer: [number, number];
  samples: number;
  environmentBytes: number;
  bufferBytes: number;
  textureBytes: number;
  budgetBytes: number;
  failed: StageRuntimeFailReason | null;
};

export type StageRuntimeBench = StageRuntime & {
  /** Optional start centre (the contract's prepare() takes none). */
  prepare(track?: number): Promise<void>;
  /** Bench and QA only. */
  debug(): StageRuntimeDebug;
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

  let direction: DirectionState | null = null;
  let promotion: PromotionState = { ...NO_PROMOTION };
  let lastTrack: number | null = null;
  let prepared: Promise<void> | null = null;
  let booting = true;

  let inflight = 0;
  let uploadedBytes = 0;
  let needsDraw = true;
  const lastState = new Float64Array(8).fill(Number.NaN);
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
    if (res === 'full') return textureBytes(slot.width, slot.height);
    const [w, h] = halfSize(slot.width, slot.height);
    return textureBytes(w, h);
  };

  const disposeVariant = (v: Variant | null) => {
    if (!v || v.state === 'disposed') return;
    if (v.state === 'uploaded') uploadedBytes -= v.bytes;
    v.state = 'disposed';
    if (v.model) v.model.removeFromParent();
    v.model = null;
    v.handle.dispose();
    counters.disposals++;
    needsDraw = true;
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
    const anisotropy = st.renderer.capabilities.getMaxAnisotropy();
    const handle = openPack3d(slot.id, {
      resolution: res,
      envMap: st.environment.texture,
      anisotropy:
        tier === 'lite'
          ? Math.min(anisotropy, LITE_MAX_ANISOTROPY)
          : anisotropy,
      foil: tier === 'lite' ? LITE_FOIL : undefined,
    });
    if (!handle) {
      if (res === 'half') slot.halfFailed = true;
      else slot.fullFailed = true;
      return null;
    }
    const v: Variant = {
      res,
      handle,
      model: null,
      bytes: 0,
      state: 'loading',
      baseEnv: 1,
      baseGlow: 0,
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
    handle
      .model()
      .then(
        async (model) => {
          if (v.state !== 'loading' || dead()) return;
          const material = model.material;
          // Fade by slot opacity without a second program: transparent from
          // the start (at opacity 1 it draws exactly as an opaque pack).
          material.transparent = true;
          v.baseEnv = material.envMapIntensity;
          v.baseGlow = material.emissiveIntensity;
          v.bytes = handle.textures().reduce((s, t) => s + t.bytes, 0);
          v.model = model;
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
    const model = v.model;
    if (!st || !model || v.state !== 'built') return;
    const map = model.material.map;
    if (map) st.renderer.initTexture(map);
    model.visible = false;
    st.scene.add(model);
    v.state = 'uploaded';
    uploadedBytes += v.bytes;
    counters.uploads++;
    needsDraw = true;
  };

  // --- residency ---------------------------------------------------------------

  const applyPlan = (track: number, now: number) => {
    if (slots.length === 0) return;
    const resident = new Map<number, ResidentInfo>();
    for (const s of slots)
      if (s.half || s.full) resident.set(s.index, { lastNeeded: s.lastNeeded });
    const plan = planResidency({
      indices: slots.filter((s) => !s.halfFailed).map((s) => s.index),
      track,
      direction: direction?.dir ?? 0,
      config,
      promote: promotion.index,
      budgetBytes: budget(),
      bytes: (i, res) => {
        const s = byIndex.get(i);
        return s ? estimateBytes(s, res) : 0;
      },
      resident,
      now,
    });
    for (const i of plan.stamp) {
      const s = byIndex.get(i);
      if (s) s.lastNeeded = now;
    }
    // Drop first, then load, so the budget is never exceeded on the way.
    for (const s of slots) {
      const w = plan.want.get(s.index);
      s.wantFull = w?.full === true;
      if (!w) {
        disposeSlot(s);
        continue;
      }
      if (!w.full && s.full) {
        disposeVariant(s.full);
        s.full = null;
      }
    }
    for (const s of slots) {
      const w = plan.want.get(s.index);
      if (!w) continue;
      if (!s.half && !s.halfFailed) s.half = startVariant(s, 'half');
      if (w.full && !s.full && !s.fullFailed && s.half?.state === 'uploaded')
        s.full = startVariant(s, 'full');
    }
  };

  /** The next variant to upload: wanted, built, nearest the centre, half first. */
  const nextUpload = (track: number): Variant | null => {
    let best: Variant | null = null;
    let bestScore = Infinity;
    for (const s of slots) {
      for (const v of [s.half, s.full]) {
        if (!v || v.state !== 'built') continue;
        const score =
          Math.abs(s.index - track) * 2 + (v.res === 'full' ? 1 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = v;
        }
      }
    }
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

  const resize = (w: number, h: number, dpr: number) => {
    if (dead()) return;
    const st = ensureStage(dpr);
    if (!st) return;
    sized = true;
    hostW = Math.max(0, w);
    hostH = Math.max(0, h);
    pixelRatio = Math.max(0.5, Math.min(dpr > 0 ? dpr : 1, cap));
    if (hostW > 0 && hostH > 0) {
      st.renderer.setPixelRatio(pixelRatio);
      st.renderer.setSize(hostW, hostH, false);
      st.camera.aspect = hostW / hostH;
      st.camera.updateProjectionMatrix();
    }
    updateBufferBytes();
    needsDraw = true;
  };

  const setPacks = (list: StageRuntimePack[] | null) => {
    if (dead()) return;
    const next = list ?? [];
    const key = next
      .map((p) => `${slotKey(p)}@${p.index}${p.soldOut ? 's' : ''}`)
      .join(',');
    if (key === packsKey) return;
    packsKey = key;
    const old = new Map(slots.map((s) => [s.key, s]));
    const fresh: Slot[] = [];
    for (const p of next) {
      const k = slotKey(p);
      const prev = old.get(k);
      if (prev) {
        old.delete(k);
        prev.index = p.index;
        prev.soldOut = p.soldOut;
        fresh.push(prev);
        continue;
      }
      fresh.push({
        key: k,
        id: p.id,
        index: p.index,
        soldOut: p.soldOut,
        width: p.art.width,
        height: p.art.height,
        half: null,
        full: null,
        halfFailed: false,
        fullFailed: false,
        lastNeeded: Number.NEGATIVE_INFINITY,
        wantFull: false,
      });
    }
    const carried = fresh.some((s) => s.half || s.full);
    for (const s of old.values()) disposeSlot(s);
    slots = fresh;
    byIndex = new Map(fresh.map((s) => [s.index, s]));
    promotion = { ...NO_PROMOTION };
    needsDraw = true;
    if (!carried && next.length > 0 && old.size > 0) {
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
      for (let i = 0; i < 8; i++) lastState[i] = Number.NaN;
    }
    if (!booting && stage) {
      // A later list (category switch, reload after release): start the
      // centre +-1 now; render() takes it from there.
      applyPlan(defaultCentre(), 0);
    }
  };

  const setLayout = (l: StageLayout) => {
    if (dead()) return;
    layout = { cx: l.cx, cy: l.cy, step: l.step, artH: l.artH };
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
    ];
    let changed = false;
    for (let i = 0; i < 8; i++) {
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
      const promoteOn =
        desktop && tier === 'full' && pixelRatio >= PROMOTE_MIN_DPR;
      promotion = nextPromotion(promotion, track, now, promoteOn);
      if (!booting) applyPlan(track, now);
      const next = booting ? null : nextUpload(track);
      if (next) upload(next);

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
        for (const slot of slots) {
          const shown = drawnVariant(slot);
          for (const v of [slot.half, slot.full])
            if (v?.model && v !== shown) v.model.visible = false;
          const model = shown?.model;
          if (!shown || !model) continue;
          const opacity = slotOpacity(slot.index - track, desktop);
          if (opacity <= 0) {
            model.visible = false;
            continue;
          }
          const pose = poseAt(s, slot.index, l, desktop, slot.soldOut);
          placeModel(
            model,
            pose,
            l.cx + (slot.index - track) * l.step,
            l,
            hostW,
            hostH,
          );
          const m = model.material;
          m.opacity = opacity;
          m.color.setScalar(pose.dim);
          m.emissiveIntensity = shown.baseGlow * pose.dim;
          m.envMapIntensity =
            shown.baseEnv * Math.pow(Math.max(0, pose.dim), ENV_DIM_EXPONENT);
          model.visible = true;
          model.updateMatrixWorld(true);
          if (frustum.intersectsObject(model.mesh)) live.push(slot.id);
        }
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
        slots.some(
          (sl) =>
            sl.half?.state === 'built' ||
            sl.full?.state === 'built' ||
            (sl.wantFull && sl.full?.state !== 'uploaded' && !sl.fullFailed),
        ) ||
        promotionPending(promotion, track, promoteOn) ||
        (needsDraw && canDraw);
      return { live: [...live], wantsFrame: pending };
    } catch {
      fail('error');
      return { live: [], wantsFrame: false };
    }
  };

  const stats = (): StageRuntimeStats => {
    if (finalInfo) return finalInfo;
    const info = stage?.renderer.info;
    return {
      textures: info?.memory.textures ?? 0,
      geometries: info?.memory.geometries ?? 0,
      programs: info?.programs?.length ?? 0,
      gpuBytesEstimate: stage
        ? bufferBytes + stage.environmentBytes + uploadedBytes
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
      pixelRatio,
      drawingBuffer: gl
        ? [gl.drawingBufferWidth, gl.drawingBufferHeight]
        : [0, 0],
      samples: stage?.samples ?? 0,
      environmentBytes: stage?.environmentBytes ?? 0,
      bufferBytes,
      textureBytes: uploadedBytes,
      budgetBytes: budget(),
      failed,
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
    for (const s of slots) disposeSlot(s);
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
    setLayout,
    prepare,
    render,
    stats,
    dispose,
    debug,
  };
}
