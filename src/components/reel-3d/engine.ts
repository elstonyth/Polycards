// The 3D reel engine: plain three.js and DOM, no React. A drop-in for the DOM
// reel's motion. Every reel runs today's physics (pressSpinOffset at a fixed
// virtual pitch, PITCH) and its strip content comes from today's builder
// (buildPressStrip), whose idle tiling `pool[(i + reel * 4) % len]` is exactly
// the endless strip drawn here, so the press launches seamlessly.
//
// Driven, not self-timed: spin() starts a spin, the engine reports every cell
// crossing and each reel's landed winner rect, and the reels stay landed until
// release(). The page owns the flood, the sounds and the reveal.
import * as THREE from 'three';
import {
  columnDurationMs,
  pressSpinOffset,
  pressTravelPx,
} from '@/lib/vault-reel';
import {
  buildPressStrip,
  DECOY_DEXES,
  decoyRarity,
  type HReelCell,
} from '@/lib/hreel';
import type { Rarity } from '@/lib/packs-data';
import { RARITY_ORDER, RARITY_RGB } from '@/lib/rarity';
import {
  armBootGuard,
  markCrashed,
  type BootGuard,
} from '@/components/pack-stage/crash-guard';
import { Atlas } from './atlas';
import {
  CARD_H,
  CARD_W,
  cellGeometry,
  cellMaterial,
  haloGeometry,
  haloMaterial,
} from './shaders';
import { CURVED, type Placement, type View } from './layouts';

/** Virtual pitch (px) the physics runs at. */
const PITCH = 110;
/** Today's idle creep, virtual px per ms. */
const IDLE_DRIFT = 0.02;
/** The landed winner's bloom-in. */
const LAND_MS = 300;

/** What a reel lands on: the DOM reel's ColumnWinner fields it uses. */
export type ReelWinner = {
  dex: number | null;
  image?: string;
  label?: string;
  rarity: Rarity;
};

type Spin = {
  at: number;
  count: number;
  start: number[];
  target: number[];
  idx: number[];
  dur: number[];
  remaining: number[];
  settled: boolean[];
  end: number;
};

type Reel = {
  px: number;
  pool: HReelCell[];
  overrides: Map<number, HReelCell>;
};

type ReelMeshes = {
  cells: THREE.InstancedMesh;
  halos: THREE.InstancedMesh;
  sprite: THREE.InstancedBufferAttribute;
  state: THREE.InstancedBufferAttribute;
  live: number;
};

const LIVE = 16;
const mod = (a: number, n: number) => ((a % n) + n) % n;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const FALLBACK_POOL: HReelCell[] = DECOY_DEXES.map((dex, i) => ({
  dex,
  rarity: decoyRarity(i),
}));

const RARITY_COLOR = new Map<Rarity, THREE.Color>(
  RARITY_ORDER.map((r) => {
    const [cr, cg, cb] = RARITY_RGB[r].split(',').map((v) => Number(v) / 255);
    return [r, new THREE.Color().setRGB(cr!, cg!, cb!, THREE.SRGBColorSpace)];
  }),
);

export type EngineOptions = {
  host: HTMLElement;
  reduced: boolean;
  /** A cell centred on the winning line (the tick track). */
  onCellCross?: () => void;
  /** Reel `reel` stopped; `rect` is its winner card on screen. */
  onReelSettled?: (reel: number, rect: DOMRect) => void;
  /** The first pools are drawn: the canvas can replace the DOM reel. */
  onReady?: () => void;
  /** The GPU context died: fall back to the DOM reel. */
  onLost?: () => void;
};

export class ReelEngine {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private markerEl: HTMLDivElement;
  private renderer: THREE.WebGLRenderer;
  private guard: BootGuard;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  private atlas = new Atlas();
  private cellMat: THREE.ShaderMaterial;
  private haloMat: THREE.ShaderMaterial;
  private cellGeo = cellGeometry();
  private haloGeo = haloGeometry();
  private meshes: ReelMeshes[] = [];
  private count = 1;
  private cellPx = 96;
  /** The last configure() call, applied once no spin is held. */
  private want = { count: 1, cellPx: 96 };
  private reels: Reel[] = [];
  private spin: Spin | null = null;
  private hideWinners = false;
  private paused = false;
  private reduced: boolean;
  private opts: EngineOptions;
  private ready = false;
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

  /** Returns null when WebGL cannot start. */
  static create(opts: EngineOptions): ReelEngine | null {
    const canvas = document.createElement('canvas');
    // A 'boot' flag that outlives this load means the GPU took the tab down.
    // The flag is the pack stage's on purpose: one GPU, one session, so a
    // crash on either page keeps both flat.
    const guard = armBootGuard();
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        powerPreference: 'default',
      });
      if (!renderer.getContext()) {
        guard.settle();
        return null;
      }
    } catch {
      guard.settle();
      return null;
    }
    return new ReelEngine(opts, canvas, renderer, guard);
  }

  private constructor(
    opts: EngineOptions,
    canvas: HTMLCanvasElement,
    renderer: THREE.WebGLRenderer,
    guard: BootGuard,
  ) {
    this.opts = opts;
    this.host = opts.host;
    this.reduced = opts.reduced;
    this.canvas = canvas;
    this.renderer = renderer;
    this.guard = guard;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;';
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.markerEl = document.createElement('div');
    this.markerEl.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;';
    this.markerEl.innerHTML =
      '<div style="position:absolute;left:0;top:8px;bottom:8px;width:1px;transform:translateX(-50%);background:linear-gradient(to bottom,transparent,rgba(255,255,255,0.7) 10%,rgba(255,255,255,0.7) 90%,transparent);box-shadow:0 0 6px rgba(255,255,255,0.35)"></div>' +
      '<div style="position:absolute;left:0;top:0;width:8px;height:8px;transform:translateX(-50%) rotate(45deg);border-right:1px solid rgba(255,255,255,0.75);border-bottom:1px solid rgba(255,255,255,0.75)"></div>' +
      '<div style="position:absolute;left:0;bottom:0;width:8px;height:8px;transform:translateX(-50%) rotate(45deg);border-left:1px solid rgba(255,255,255,0.75);border-top:1px solid rgba(255,255,255,0.75)"></div>';
    this.host.append(canvas, this.markerEl);

    this.cellMat = cellMaterial(this.atlas.texture, this.atlas.tileUv);
    this.haloMat = haloMaterial(1.15);

    for (let r = 0; r < 3; r++) {
      this.reels.push({
        px: PITCH * (3.3 + r * 1.7),
        pool: FALLBACK_POOL,
        overrides: new Map(),
      });
    }

    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.host);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.rebuild();
  }

  // ------------------------------------------------------------ public API

  /** Reel count and the DOM reel's cell size; held until a spin releases. */
  configure(count: number, cellPx: number) {
    this.want = { count: Math.min(3, Math.max(1, count)), cellPx };
    if (!this.spin) this.applyConfig();
  }

  private applyConfig() {
    const { count, cellPx } = this.want;
    if (count === this.count && cellPx === this.cellPx) return;
    const rebuild = count !== this.count;
    this.count = count;
    this.cellPx = cellPx;
    if (rebuild) this.rebuild();
    else this.layout();
  }

  private poolCells(): HReelCell[] {
    return this.reels.flatMap((reel) => reel.pool);
  }

  /** Idle content per reel (the page's per-idle-cycle shuffles). */
  setPools(pools: readonly (readonly HReelCell[])[]) {
    this.reels.forEach((reel, r) => {
      const p = pools[r] ?? pools[0];
      reel.pool = p && p.length > 0 ? [...p] : FALLBACK_POOL;
    });
    void this.atlas.ensure(this.poolCells()).then(() => {
      if (this.disposed) return;
      this.renderNow();
      if (!this.ready) {
        this.ready = true;
        this.opts.onReady?.();
      }
    });
  }

  /**
   * Start a spin from wherever the reels are drifting. Reel r lands on
   * winners[r]; a reel with no winner (a partial batch after a failed mapping)
   * stops where it is and lands on nothing, as the DOM reel leaves it idle.
   */
  spinNow(winners: readonly ReelWinner[], seed: number) {
    if (this.spin || winners.length === 0) return;
    const now = performance.now();
    const n = this.count;
    const spin: Spin = {
      at: now,
      count: n,
      start: [],
      target: [],
      idx: [],
      dur: [],
      remaining: [],
      settled: [],
      end: 0,
    };
    const wanted: HReelCell[] = [];
    for (let r = 0; r < n; r++) {
      const reel = this.reels[r]!;
      const w = winners[r];
      const start = reel.px;
      if (!w) {
        spin.start.push(start);
        spin.target.push(start);
        spin.idx.push(Number.NaN);
        spin.dur.push(0);
        spin.remaining.push(0);
        spin.settled.push(true);
        continue;
      }
      const idx = Math.round((start + pressTravelPx(r, n, PITCH)) / PITCH);
      // Everything on screen at press time keeps its idle content.
      const keep = Math.min(Math.floor(start / PITCH) + LIVE / 2 + 1, idx - 1);
      const strip = buildPressStrip({
        winnerDex: w.dex,
        winnerImage: w.image,
        winnerLabel: w.label,
        winnerRarity: w.rarity,
        winIndex: idx,
        keepCells: keep,
        seed: r,
        rngSeed: seed + r * 0x1003,
        decoyCards: reel.pool,
      });
      reel.overrides.clear();
      for (let k = keep; k < strip.length; k++)
        reel.overrides.set(k, strip[k]!);
      wanted.push(strip[idx]!);
      const target = idx * PITCH;
      spin.start.push(start);
      spin.target.push(target);
      spin.idx.push(idx);
      spin.dur.push(columnDurationMs(r, n));
      spin.remaining.push(Math.max(0, Math.floor((target - start) / PITCH)));
      spin.settled.push(false);
    }
    spin.end = Math.max(...spin.dur);
    // Reduced motion: land at once, as the DOM reel does.
    if (this.reduced) spin.at = now - spin.end;
    this.spin = spin;
    // The winners may be cards the pool never showed (a seeded card's art).
    // Winners first, then the pools: a full atlas resets and must get the
    // cells on screen back, not only the winners.
    void this.atlas
      .ensure([...wanted, ...this.poolCells()])
      .then(() => this.renderNow());
    this.ensureLoop();
  }

  /** Back to idle (the page cleared its winners). */
  release() {
    if (!this.spin) return;
    this.spin.target.forEach((px, r) => {
      this.reels[r]!.px = px;
      this.reels[r]!.overrides.clear();
    });
    this.spin = null;
    this.applyConfig();
    this.ensureLoop();
  }

  setHideWinners(hide: boolean) {
    if (hide === this.hideWinners) return;
    this.hideWinners = hide;
    this.renderNow();
  }

  /** Stop drawing while the reveal covers the machine. */
  setPaused(paused: boolean) {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.stopLoop();
    else this.ensureLoop();
  }

  dispose() {
    this.disposed = true;
    this.guard.settle();
    this.stopLoop();
    this.resizeObs.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.clearScene();
    this.cellGeo.dispose();
    this.haloGeo.dispose();
    this.cellMat.dispose();
    this.haloMat.dispose();
    this.atlas.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    this.markerEl.remove();
  }

  // ------------------------------------------------------------ internals

  private onContextLost = (ev: Event) => {
    ev.preventDefault();
    markCrashed();
    this.stopLoop();
    this.opts.onLost?.();
  };

  private onVisibility = () => {
    if (document.hidden) this.stopLoop();
    else this.ensureLoop();
  };

  private ensureLoop() {
    if (this.running || this.paused || this.disposed || document.hidden) return;
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
  }

  private rebuild() {
    this.clearScene();
    for (let r = 0; r < this.count; r++) {
      const sprite = new THREE.InstancedBufferAttribute(
        new Float32Array(LIVE * 4),
        4,
      );
      const state = new THREE.InstancedBufferAttribute(
        new Float32Array(LIVE * 4),
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
      const cells = new THREE.InstancedMesh(cg, this.cellMat, LIVE);
      const halos = new THREE.InstancedMesh(hg, this.haloMat, LIVE);
      for (let j = 0; j < LIVE; j++) {
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
      this.meshes.push({ cells, halos, sprite, state, live: LIVE });
    }
    this.layout();
    this.ensureLoop();
  }

  private view(): View {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    return { w, h, cardPx: this.cellPx, phone: w < 640 };
  }

  private layout() {
    const view = this.view();
    this.renderer.setSize(view.w, view.h, false);
    this.camera.aspect = view.w / view.h;
    CURVED.camera(view, this.count, this.camera);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    const [a, b] = CURVED.marker(this.count);
    const pa = a.clone().project(this.camera);
    const pb = b.clone().project(this.camera);
    const y0 = ((1 - pa.y) / 2) * view.h;
    const y1 = ((1 - pb.y) / 2) * view.h;
    Object.assign(this.markerEl.style, {
      left: `${((pa.x + 1) / 2) * view.w}px`,
      top: `${Math.min(y0, y1)}px`,
      height: `${Math.abs(y1 - y0)}px`,
    });
    this.renderNow();
  }

  /** The winner card of reel `r` (centred on the line) in viewport px. */
  private winnerRect(r: number): DOMRect {
    const box = this.host.getBoundingClientRect();
    CURVED.place(r, this.count, 0, this.tmp);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      this.v
        .set(
          this.tmp.x + (sx * CARD_W) / 2,
          this.tmp.y + (sy * CARD_H) / 2,
          this.tmp.z,
        )
        .project(this.camera);
      const x = ((this.v.x + 1) / 2) * box.width;
      const y = ((1 - this.v.y) / 2) * box.height;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    return new DOMRect(box.left + x0, box.top + y0, x1 - x0, y1 - y0);
  }

  private cellAt(r: number, k: number): HReelCell {
    const reel = this.reels[r]!;
    return (
      reel.overrides.get(k) ?? reel.pool[mod(k + r * 4, reel.pool.length)]!
    );
  }

  private reelPx(r: number, t: number): number {
    const s = this.spin!;
    if (t >= s.dur[r]!) return s.target[r]!;
    return pressSpinOffset(t, s.start[r]!, s.target[r]!, r, s.count, PITCH);
  }

  private frame(now: number) {
    const dt = Math.min(50, now - this.last);
    this.last = now;
    const spin = this.spin;
    if (spin) {
      const t = now - spin.at;
      for (let r = 0; r < spin.count; r++) {
        if (spin.settled[r]) continue;
        const left = Math.max(
          0,
          Math.floor((spin.target[r]! - this.reelPx(r, t)) / PITCH),
        );
        if (left < spin.remaining[r]!) {
          spin.remaining[r] = left;
          this.opts.onCellCross?.();
        }
        if (t >= spin.dur[r]!) {
          spin.settled[r] = true;
          this.opts.onReelSettled?.(r, this.winnerRect(r));
        }
      }
      this.draw(t);
      // Landed and bloomed: hold the frame until release().
      if (t >= spin.end + LAND_MS) this.stopLoop();
      return;
    }
    if (!this.reduced)
      for (const reel of this.reels) reel.px += dt * IDLE_DRIFT;
    this.draw(-1);
  }

  private renderNow() {
    if (this.disposed) return;
    this.draw(this.spin ? performance.now() - this.spin.at : -1);
  }

  /** Paint the scene at spin time `t` (t < 0 = idle at the reels' px). */
  private draw(t: number) {
    const spin = t >= 0 ? this.spin : null;
    const n = this.count;
    for (let r = 0; r < n; r++) {
      const mesh = this.meshes[r];
      if (!mesh) continue;
      const reel = this.reels[r]!;
      let px = reel.px;
      let vel = this.reduced || spin ? 0 : IDLE_DRIFT;
      let settledFor = -1;
      if (spin) {
        px = this.reelPx(r, t);
        vel = (px - this.reelPx(r, Math.max(0, t - 12))) / 12;
        if (t >= spin.dur[r]!) settledFor = t - spin.dur[r]!;
      }
      const speed = clamp01((Math.abs(vel) - 0.06) / 2.4);
      const base = px / PITCH;
      const first = Math.ceil(base - mesh.live / 2);
      for (let slot = 0; slot < mesh.live; slot++) {
        const k = first + slot;
        const p = this.tmp;
        CURVED.place(r, n, k - base, p);
        const cell = this.cellAt(r, k);
        const isWinner = spin !== null && k === spin.idx[r];
        let lit = 1;
        let landed = 0;
        let fade = p.fade;
        if (settledFor >= 0) {
          // Landed: decoys cut to neutral, the winner blooms in.
          lit = isWinner ? 1 : 0;
          landed = isWinner ? clamp01(settledFor / LAND_MS) : 0;
          if (isWinner && this.hideWinners) fade = 1;
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
        // Art still loading: the neutral card back, never an empty frame.
        const sl = this.atlas.slot(cell) ?? this.atlas.placeholder();
        mesh.sprite.setXYZW(
          slot,
          sl?.u0 ?? 0,
          sl?.v0 ?? 0,
          sl?.scale ?? 1,
          sl ? 0 : 1,
        );
        mesh.state.setXYZW(slot, lit, landed, fade, speed);
      }
      mesh.cells.instanceMatrix.needsUpdate = true;
      mesh.halos.instanceMatrix.needsUpdate = true;
      mesh.cells.instanceColor!.needsUpdate = true;
      mesh.halos.instanceColor!.needsUpdate = true;
      mesh.sprite.needsUpdate = true;
      mesh.state.needsUpdate = true;
    }
    this.renderer.render(this.scene, this.camera);
  }
}
