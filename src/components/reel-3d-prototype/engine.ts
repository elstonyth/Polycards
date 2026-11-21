// PROTOTYPE, throwaway: the 3D reel engine behind /reel-preview (looks a, b, c).
// Plain three.js and DOM, no React or Next, so the static harness in
// docs/research/home-3d/reel/prototype/harness loads it too.
//
// Motion is today's: every reel runs pressSpinOffset in virtual px at a fixed
// pitch (PITCH) and the result is turned into cell offsets. Every frame is a
// pure function of (reel positions at press, winners, spin seed, t), so the
// `?t=` stills match the live spin.
import * as THREE from 'three';
import type { Rarity } from '@/lib/packs-data';
import {
  columnDurationMs,
  pressSpinOffset,
  pressTravelPx,
  WINDUP_MS,
  BLUR_MS,
  FRICTION_MS,
  CRAWL_MS,
  STOP_STAGGER_MS,
} from '@/lib/vault-reel';
import { RARITY_ORDER, RARITY_RGB } from '@/lib/rarity';
import {
  MOCK_POOL,
  bestRarity,
  cellOfRarity,
  mulberry32,
  pickWinners,
  teaseRarity,
  type MockCell,
} from './mock';
import { buildAtlas, type Atlas, type AtlasSlot } from './atlas';
import {
  cellGeometry,
  cellMaterial,
  haloGeometry,
  haloMaterial,
} from './shaders';
import {
  LOOKS,
  type Look,
  type LookLayout,
  type Placement,
  type View,
} from './layouts';

/** Virtual pitch (px) the physics runs at. */
export const PITCH = 110;
/** Today's idle creep, virtual px per ms. */
export const IDLE_DRIFT = 0.02;
const FLOOD_MS = 1600;
const IDLE_AFTER_MS = 2000;
const LAND_MS = 300;
const BACK_MS = 250;

export type Phase =
  | 'idle'
  | 'windup'
  | 'fast'
  | 'slowing'
  | 'crawl'
  | 'settle'
  | 'flood'
  | 'landed';

export type SeekParams = {
  t: number;
  seed: number;
  win: Rarity | null;
  reels: number;
};

export type EngineStats = {
  look: Look | null;
  phase: Phase;
  speed: number;
  calls: number;
  cells: number;
  textureBytes: number;
};

type Spin = {
  at: number;
  count: number;
  start: number[];
  target: number[];
  idx: number[];
  winners: MockCell[];
  end: number;
  floodRgb: string;
};

type Reel = {
  px: number;
  pool: MockCell[];
  overrides: Map<number, MockCell>;
};

type ReelMeshes = {
  cells: THREE.InstancedMesh;
  halos: THREE.InstancedMesh;
  sprite: THREE.InstancedBufferAttribute;
  state: THREE.InstancedBufferAttribute;
  live: number;
};

const mod = (a: number, n: number) => ((a % n) + n) % n;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Total run of the last reel (when the whole spin has settled). */
export const spinEndMs = (count: number) => columnDurationMs(count - 1, count);

export function phaseAt(t: number, count: number): Phase {
  if (t < 0) return 'idle';
  const end = spinEndMs(count);
  const accelLast = BLUR_MS + (count - 1) * STOP_STAGGER_MS;
  const frictionLastEnd = WINDUP_MS + accelLast + FRICTION_MS;
  if (t < WINDUP_MS) return 'windup';
  if (t < WINDUP_MS + BLUR_MS) return 'fast';
  if (t < frictionLastEnd) return 'slowing';
  if (t < frictionLastEnd + CRAWL_MS) return 'crawl';
  if (t < end) return 'settle';
  if (t < end + FLOOD_MS) return 'flood';
  if (t < end + IDLE_AFTER_MS) return 'landed';
  return 'idle';
}

function shuffled(cells: readonly MockCell[], seed: number): MockCell[] {
  const rand = mulberry32(seed);
  const out = [...cells];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const RARITY_COLOR = new Map<Rarity, THREE.Color>(
  RARITY_ORDER.map((r) => {
    const [cr, cg, cb] = RARITY_RGB[r].split(',').map((v) => Number(v) / 255);
    return [r, new THREE.Color().setRGB(cr!, cg!, cb!, THREE.SRGBColorSpace)];
  }),
);

/** Today's cell height for this viewport and reel count (SlotMachineClient). */
export function todayCellPx(w: number, h: number, count: number): number {
  const roomy = w >= 768 && h >= 720;
  return count > 1 ? (roomy ? 116 : 76) : roomy ? 152 : 96;
}

export type EngineOptions = {
  host: HTMLElement;
  reduced: boolean;
  onPhase?: (phase: Phase) => void;
};

export class ReelEngine {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private floodEl: HTMLDivElement;
  private markerEl: HTMLDivElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  private atlas: Atlas | null = null;
  private blank: THREE.DataTexture;
  private cellMat: THREE.ShaderMaterial;
  private haloMat: THREE.ShaderMaterial;
  private cellGeo = cellGeometry();
  private haloGeo = haloGeometry();
  private lineMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.09,
    depthWrite: false,
  });
  private guides: THREE.LineSegments | null = null;
  private meshes: ReelMeshes[] = [];
  private look: Look | null = null;
  private count = 1;
  private reels: Reel[] = [];
  private spin: Spin | null = null;
  private reduced: boolean;
  private onPhase?: (phase: Phase) => void;
  private phase: Phase = 'idle';
  private speed = 0;
  private insets = { top: 0, bottom: 0 };
  private seekState: { t: number } | null = null;
  private running = false;
  private last = 0;
  private resizeObs: ResizeObserver;
  private disposed = false;
  private tmp: Placement = {
    x: 0,
    y: 0,
    z: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    scale: 1,
    fade: 0,
  };
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private order: { z: number; j: number }[] = [];
  private spinSeed = 1;

  /** Returns null when WebGL cannot start. */
  static create(opts: EngineOptions): ReelEngine | null {
    const canvas = document.createElement('canvas');
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        powerPreference: 'default',
      });
      if (!renderer.getContext()) return null;
    } catch {
      return null;
    }
    return new ReelEngine(opts, canvas, renderer);
  }

  private constructor(
    opts: EngineOptions,
    canvas: HTMLCanvasElement,
    renderer: THREE.WebGLRenderer,
  ) {
    this.host = opts.host;
    this.reduced = opts.reduced;
    this.onPhase = opts.onPhase;
    this.canvas = canvas;
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.floodEl = document.createElement('div');
    this.floodEl.style.cssText =
      'position:absolute;inset:0;pointer-events:none;opacity:0;';
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;';
    this.markerEl = document.createElement('div');
    this.markerEl.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;display:none;';
    this.markerEl.innerHTML =
      '<div style="position:absolute;left:0;top:8px;bottom:8px;width:1px;transform:translateX(-50%);background:linear-gradient(to bottom,transparent,rgba(255,255,255,0.7) 10%,rgba(255,255,255,0.7) 90%,transparent);box-shadow:0 0 6px rgba(255,255,255,0.35)"></div>' +
      '<div style="position:absolute;left:0;top:0;width:8px;height:8px;transform:translateX(-50%) rotate(45deg);border-right:1px solid rgba(255,255,255,0.75);border-bottom:1px solid rgba(255,255,255,0.75)"></div>' +
      '<div style="position:absolute;left:0;bottom:0;width:8px;height:8px;transform:translateX(-50%) rotate(45deg);border-left:1px solid rgba(255,255,255,0.75);border-top:1px solid rgba(255,255,255,0.75)"></div>';
    this.host.append(this.floodEl, canvas, this.markerEl);

    this.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this.blank.needsUpdate = true;
    this.cellMat = cellMaterial(this.blank, [1, 1]);
    this.haloMat = haloMaterial(1.15);

    for (let r = 0; r < 3; r++) {
      this.reels.push({
        px: PITCH * (3.3 + r * 1.7),
        pool: shuffled(MOCK_POOL, 101 + r * 7),
        overrides: new Map(),
      });
    }

    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.host);
    document.addEventListener('visibilitychange', this.onVisibility);

    void buildAtlas(MOCK_POOL.map((c) => c.dex)).then((atlas) => {
      if (this.disposed) {
        atlas.texture.dispose();
        return;
      }
      this.atlas = atlas;
      this.cellMat.uniforms.uAtlas!.value = atlas.texture;
      (this.cellMat.uniforms.uTileUv!.value as THREE.Vector2).set(
        atlas.tileUv[0],
        atlas.tileUv[1],
      );
      this.renderNow();
      this.host.dataset.reelReady = '1';
    });
  }

  // ------------------------------------------------------------ public API

  setInsets(top: number, bottom: number) {
    this.insets = { top, bottom };
    this.layout();
  }

  setLook(look: Look | null) {
    if (!look && this.spin) {
      // Leaving 3D mid-spin: land every reel at once.
      this.spin.target.forEach((px, r) => (this.reels[r]!.px = px));
      this.spin = null;
      this.phase = 'idle';
      this.onPhase?.('idle');
    }
    this.look = look;
    this.rebuild();
  }

  setReels(count: number) {
    if (this.spin) return;
    this.count = Math.min(3, Math.max(1, count));
    this.rebuild();
  }

  isBusy() {
    return this.spin !== null;
  }

  spinNow(winners: MockCell[]) {
    if (this.spin || !this.look) return;
    const now = performance.now();
    this.spinSeed = (this.spinSeed * 1103515245 + 12345) >>> 0;
    this.startSpin(now, winners, this.spinSeed);
    if (this.reduced) this.spin!.at = now - this.spin!.end;
    this.ensureLoop();
  }

  /** Freeze the spin at `t` ms after a press, deterministically. */
  seek(p: SeekParams) {
    this.stopLoop();
    this.seekState = { t: p.t };
    this.count = Math.min(3, Math.max(1, p.reels));
    this.spin = null;
    this.reels.forEach((reel, r) => {
      reel.px = ((p.seed * 37 + r * 53) % 997) + PITCH * (2.3 + r * 1.9);
      reel.overrides.clear();
    });
    this.rebuild();
    if (p.t >= 0) {
      const rand = mulberry32(p.seed * 7919 + 17);
      const winners = p.win
        ? Array.from({ length: this.count }, () => cellOfRarity(p.win!, rand))
        : pickWinners(this.count, rand);
      this.startSpin(0, winners, p.seed);
    }
    this.renderNow();
  }

  stats(): EngineStats {
    return {
      look: this.look,
      phase: this.phase,
      speed: this.speed,
      calls: this.renderer.info.render.calls,
      cells: this.meshes.reduce((s, m) => s + m.live, 0),
      textureBytes: this.atlas?.bytes ?? 0,
    };
  }

  dispose() {
    this.disposed = true;
    this.stopLoop();
    this.resizeObs.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.clearScene();
    this.cellGeo.dispose();
    this.haloGeo.dispose();
    this.cellMat.dispose();
    this.haloMat.dispose();
    this.lineMat.dispose();
    this.blank.dispose();
    this.atlas?.texture.dispose();
    this.renderer.dispose();
    this.floodEl.remove();
    this.canvas.remove();
    this.markerEl.remove();
  }

  // ------------------------------------------------------------ internals

  private onVisibility = () => {
    if (document.hidden) this.stopLoop();
    else this.ensureLoop();
  };

  private ensureLoop() {
    if (this.running || !this.look || this.seekState || document.hidden) return;
    this.running = true;
    this.last = performance.now();
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  private stopLoop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  private clearScene() {
    for (const m of this.meshes) {
      this.scene.remove(m.cells, m.halos);
      m.cells.geometry.dispose();
      m.halos.geometry.dispose();
      m.cells.dispose();
      m.halos.dispose();
    }
    this.meshes = [];
    if (this.guides) {
      this.scene.remove(this.guides);
      this.guides.geometry.dispose();
      this.guides = null;
    }
  }

  private layoutOf(): LookLayout | null {
    return this.look ? LOOKS[this.look] : null;
  }

  private rebuild() {
    this.clearScene();
    const L = this.layoutOf();
    this.canvas.style.visibility = L ? 'visible' : 'hidden';
    this.markerEl.style.display = L ? 'block' : 'none';
    if (!L) {
      this.stopLoop();
      this.floodEl.style.opacity = '0';
      return;
    }
    // The drum's near cards are a little more opaque so the far side reads
    // as behind them, not mixed in.
    this.cellMat.uniforms.uBgAlpha!.value = this.look === 'b' ? 0.75 : 0.55;
    for (let r = 0; r < this.count; r++) {
      const live = L.live(r, this.count);
      const sprite = new THREE.InstancedBufferAttribute(
        new Float32Array(live * 4),
        4,
      );
      const state = new THREE.InstancedBufferAttribute(
        new Float32Array(live * 4),
        4,
      );
      sprite.setUsage(THREE.DynamicDrawUsage);
      state.setUsage(THREE.DynamicDrawUsage);
      const cg = this.cellGeo.clone();
      const hg = this.haloGeo.clone();
      cg.setAttribute('aSprite', sprite);
      cg.setAttribute('aState', state);
      hg.setAttribute('aSprite', sprite);
      hg.setAttribute('aState', state);
      const cells = new THREE.InstancedMesh(cg, this.cellMat, live);
      const halos = new THREE.InstancedMesh(hg, this.haloMat, live);
      for (let j = 0; j < live; j++) {
        cells.setColorAt(j, RARITY_COLOR.get('Common')!);
        halos.setColorAt(j, RARITY_COLOR.get('Common')!);
      }
      cells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      halos.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      cells.frustumCulled = false;
      halos.frustumCulled = false;
      cells.renderOrder = 1;
      halos.renderOrder = 2;
      this.scene.add(cells, halos);
      this.meshes.push({ cells, halos, sprite, state, live });
    }
    const g = L.guides(this.count);
    if (g) {
      this.guides = new THREE.LineSegments(g, this.lineMat);
      this.guides.renderOrder = 0;
      this.scene.add(this.guides);
    }
    this.layout();
    if (this.seekState) this.renderNow();
    else this.ensureLoop();
  }

  private view(): View {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    return {
      w,
      h,
      stageH: Math.max(1, h - this.insets.top - this.insets.bottom),
      cardPx: todayCellPx(w, h, this.count),
      phone: w < 640,
    };
  }

  private layout() {
    const L = this.layoutOf();
    const view = this.view();
    this.renderer.setSize(view.w, view.h, false);
    this.camera.aspect = view.w / view.h;
    if (!L) return;
    L.camera(view, this.count, this.camera);
    // Centre the reel in the stage (above the controls) with a view offset.
    const centreY = this.insets.top + view.stageH / 2;
    this.camera.setViewOffset(
      view.w,
      view.h,
      0,
      view.h / 2 - centreY,
      view.w,
      view.h,
    );
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    const [a, b] = L.marker(this.count);
    const pa = a.clone().project(this.camera);
    const pb = b.clone().project(this.camera);
    const x = ((pa.x + 1) / 2) * view.w;
    const y0 = ((1 - pa.y) / 2) * view.h;
    const y1 = ((1 - pb.y) / 2) * view.h;
    Object.assign(this.markerEl.style, {
      left: `${x}px`,
      top: `${Math.min(y0, y1)}px`,
      height: `${Math.abs(y1 - y0)}px`,
    });
    if (this.seekState) this.renderNow();
  }

  private startSpin(at: number, winners: MockCell[], seed: number) {
    const L = this.layoutOf()!;
    const n = this.count;
    const rand = mulberry32(seed * 2654435761 + 7);
    const spin: Spin = {
      at,
      count: n,
      start: [],
      target: [],
      idx: [],
      winners,
      end: spinEndMs(n),
      floodRgb: RARITY_RGB[bestRarity(winners)],
    };
    for (let r = 0; r < n; r++) {
      const reel = this.reels[r]!;
      const live = L.live(r, n);
      const start = reel.px;
      const idx = Math.round((start + pressTravelPx(r, n, PITCH)) / PITCH);
      // Everything on screen at press time keeps its content.
      const keepUntil = Math.floor(start / PITCH) + Math.ceil(live / 2) + 1;
      const winner = winners[r]!;
      let prev = this.cellAt(r, keepUntil);
      for (let k = keepUntil + 1; k <= idx + Math.ceil(live / 2) + 2; k++) {
        let c: MockCell;
        if (k === idx) c = winner;
        else {
          c = MOCK_POOL[Math.floor(rand() * MOCK_POOL.length)]!;
          for (
            let tries = 0;
            tries < 6 &&
            (c.dex === prev.dex || (k === idx - 1 && c.dex === winner.dex));
            tries++
          ) {
            c = MOCK_POOL[Math.floor(rand() * MOCK_POOL.length)]!;
          }
        }
        reel.overrides.set(k, c);
        prev = c;
      }
      const tease = teaseRarity(winner.rarity);
      const before = reel.overrides.get(idx - 1);
      if (tease && before)
        reel.overrides.set(idx - 1, { ...before, rarity: tease });
      spin.start.push(start);
      spin.idx.push(idx);
      spin.target.push(idx * PITCH);
    }
    this.floodEl.style.background = `radial-gradient(85% 70% at 50% 46%, rgba(${spin.floodRgb}, 0.26) 0%, rgba(${spin.floodRgb}, 0.15) 28%, rgba(${spin.floodRgb}, 0.07) 48%, rgba(${spin.floodRgb}, 0.02) 64%, transparent 80%)`;
    this.spin = spin;
  }

  private cellAt(r: number, k: number): MockCell {
    const reel = this.reels[r]!;
    return (
      reel.overrides.get(k) ?? reel.pool[mod(k + r * 4, reel.pool.length)]!
    );
  }

  private reelPx(r: number, t: number): number {
    const s = this.spin!;
    const dur = columnDurationMs(r, s.count);
    if (t >= dur) return s.target[r]!;
    return pressSpinOffset(t, s.start[r]!, s.target[r]!, r, s.count, PITCH);
  }

  private frame(now: number) {
    const dt = Math.min(50, now - this.last);
    this.last = now;
    if (this.spin) {
      const t = now - this.spin.at;
      if (t >= this.spin.end + IDLE_AFTER_MS) {
        this.spin.target.forEach((px, r) => {
          const reel = this.reels[r]!;
          reel.px = px;
          const lo = Math.floor(px / PITCH) - 60;
          for (const k of reel.overrides.keys())
            if (k < lo) reel.overrides.delete(k);
        });
        this.spin = null;
      } else {
        this.draw(t);
        return;
      }
    }
    if (!this.reduced)
      for (const reel of this.reels) reel.px += dt * IDLE_DRIFT;
    this.draw(-1);
  }

  private renderNow() {
    if (!this.look) return;
    if (this.seekState) {
      const t = this.seekState.t;
      if (this.spin && t >= this.spin.end + IDLE_AFTER_MS) {
        // Back to idle: the drift resumes from where the spin landed.
        const drift = (t - this.spin.end - IDLE_AFTER_MS) * IDLE_DRIFT;
        const saved = this.reels.map((r) => r.px);
        const spin = this.spin;
        spin.target.forEach((px, r) => (this.reels[r]!.px = px + drift));
        this.spin = null;
        this.draw(-1);
        this.spin = spin;
        saved.forEach((px, r) => (this.reels[r]!.px = px));
        return;
      }
      this.draw(this.spin ? t : -1);
      return;
    }
    this.draw(this.spin ? performance.now() - this.spin.at : -1);
  }

  /** Paint the scene at spin time `t` (t < 0 = idle at the reels' px). */
  private draw(t: number) {
    const L = this.layoutOf();
    if (!L) return;
    const spin = t >= 0 ? this.spin : null;
    const n = this.count;
    let maxSpeed = 0;
    const phase = spin ? phaseAt(t, n) : 'idle';
    if (phase !== this.phase) {
      this.phase = phase;
      this.onPhase?.(phase);
    }
    if (spin) {
      const age = t - spin.end;
      const f =
        age < 0
          ? 0
          : age < 150
            ? age / 150
            : age < 700
              ? 1
              : 1 - clamp01((age - 700) / (FLOOD_MS - 700));
      this.floodEl.style.opacity = f.toFixed(3);
    } else this.floodEl.style.opacity = '0';
    const cam = this.camera;
    for (let r = 0; r < n; r++) {
      const mesh = this.meshes[r];
      if (!mesh) continue;
      const reel = this.reels[r]!;
      let px = reel.px;
      let vel = this.reduced || spin ? 0 : IDLE_DRIFT;
      let settledFor = -1;
      let backAmt = 0;
      if (spin) {
        px = this.reelPx(r, t);
        vel = (px - this.reelPx(r, Math.max(0, t - 12))) / 12;
        const dur = columnDurationMs(r, n);
        if (t >= dur) settledFor = t - dur;
        backAmt = clamp01((t - (spin.end + IDLE_AFTER_MS - BACK_MS)) / BACK_MS);
      }
      const speed = clamp01((Math.abs(vel) - 0.06) / 2.4);
      maxSpeed = Math.max(maxSpeed, Math.abs(vel));
      const live = mesh.live;
      const base = px / PITCH;
      const first = Math.ceil(base - live / 2);
      const order = this.order;
      order.length = 0;
      for (let j = 0; j < live; j++) {
        const k = first + j;
        L.place(r, n, k - base, this.tmp);
        let z = 0;
        if (L.sort) {
          this.v
            .set(this.tmp.x, this.tmp.y, this.tmp.z)
            .applyMatrix4(cam.matrixWorldInverse);
          z = this.v.z;
        }
        order.push({ z, j });
      }
      if (L.sort) order.sort((a, b) => a.z - b.z);
      for (let slot = 0; slot < live; slot++) {
        const k = first + order[slot]!.j;
        const p = this.tmp;
        L.place(r, n, k - base, p);
        const cell = this.cellAt(r, k);
        const isWinner = spin !== null && k === spin.idx[r];
        let lit = 1;
        let landed = 0;
        if (settledFor >= 0) {
          lit = isWinner ? 1 : backAmt;
          landed = isWinner ? clamp01(settledFor / LAND_MS) * (1 - backAmt) : 0;
        }
        const sc = p.scale * (1 + 0.06 * landed);
        this.e.set(p.rx, p.ry, p.rz, 'YXZ');
        this.q.setFromEuler(this.e);
        this.v.set(p.x, p.y, p.z);
        this.s.set(sc, sc, sc);
        this.m4.compose(this.v, this.q, this.s);
        mesh.cells.setMatrixAt(slot, this.m4);
        mesh.halos.setMatrixAt(slot, this.m4);
        const col =
          RARITY_COLOR.get(cell.rarity) ?? RARITY_COLOR.get('Common')!;
        mesh.cells.setColorAt(slot, col);
        mesh.halos.setColorAt(slot, col);
        const sl: AtlasSlot | undefined = this.atlas?.slots.get(cell.dex);
        mesh.sprite.setXYZW(slot, sl?.u0 ?? 0, sl?.v0 ?? 0, sl?.scale ?? 1, 0);
        mesh.state.setXYZW(slot, lit, landed, p.fade, speed);
      }
      mesh.cells.instanceMatrix.needsUpdate = true;
      mesh.halos.instanceMatrix.needsUpdate = true;
      mesh.cells.instanceColor!.needsUpdate = true;
      mesh.halos.instanceColor!.needsUpdate = true;
      mesh.sprite.needsUpdate = true;
      mesh.state.needsUpdate = true;
    }
    this.speed = maxSpeed;
    this.renderer.render(this.scene, cam);
    if (this.seekState) {
      this.host.dataset.reelCalls = String(this.renderer.info.render.calls);
    }
  }
}
