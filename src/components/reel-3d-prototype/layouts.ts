// PROTOTYPE, throwaway: where each cell sits in the three 3D looks on
// /reel-preview. A cell is addressed by its offset `u` from the winning marker,
// in cells (u > 0 = still arriving; cells stream right to left, or the look's
// equivalent). Everything here is pure geometry.
import * as THREE from 'three';
import { CARD_W } from './shaders';

export type Look = 'a' | 'b' | 'c';

/** World pitch between neighbouring cells (card + today's 10 px gap). */
export const PITCH_W = CARD_W + 0.07;

export type Placement = {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  scale: number;
  /** 0 = full, 1 = gone into the dark. */
  fade: number;
};

export type View = {
  /** Canvas size in CSS px. */
  w: number;
  h: number;
  /** Height of the area the reel is centred in (canvas minus the controls). */
  stageH: number;
  /** Today's cell height for this viewport and reel count. */
  cardPx: number;
  phone: boolean;
};

export type LookLayout = {
  /** Cells alive per reel; offsets covered are [-live/2, live/2). */
  live(reel: number, count: number): number;
  place(reel: number, count: number, u: number, out: Placement): void;
  camera(view: View, count: number, cam: THREE.PerspectiveCamera): void;
  marker(count: number): [THREE.Vector3, THREE.Vector3];
  guides(count: number): THREE.BufferGeometry | null;
  /** Sort instances far to near (only needed where cells overlap). */
  sort: boolean;
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function circle(
  pts: number[],
  r: number,
  y: number,
  plane: 'xz' | 'xy',
  seg = 96,
) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    if (plane === 'xz') {
      pts.push(Math.sin(a0) * r, y, Math.cos(a0) * r);
      pts.push(Math.sin(a1) * r, y, Math.cos(a1) * r);
    } else {
      pts.push(Math.cos(a0) * r, Math.sin(a0) * r, y);
      pts.push(Math.cos(a1) * r, Math.sin(a1) * r, y);
    }
  }
}

function lineGeometry(pts: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

const FOV = 30;
const TAN = Math.tan(((FOV / 2) * Math.PI) / 180);
/** Camera distance that makes 1 world unit = `unitPx` CSS px at depth 0. */
const distFor = (h: number, unitPx: number) => h / unitPx / (2 * TAN);

// ---------------------------------------------------------------- A: curved strip
const A_ROW = 1.45;
const rowY = (reel: number, count: number, gap: number) =>
  ((count - 1) / 2 - reel) * gap;
/** Arc radius and fog reach; a phone sees ±3 cells, so it curves tighter. */
let aR = 6.2;
let aFog = 1;

const curved: LookLayout = {
  live: () => 16,
  place(reel, count, u, o) {
    const th = (u * PITCH_W) / aR;
    const au = Math.abs(u) / aFog;
    o.x = Math.sin(th) * aR;
    o.y = rowY(reel, count, A_ROW);
    o.z = Math.cos(th) * aR - aR;
    o.rx = 0;
    o.ry = th;
    o.rz = 0;
    o.scale = 1 - 0.2 * smooth(0.6, 5.5, au);
    o.fade = 0.25 * smooth(1.5, 4, au) + 0.75 * smooth(3.6, 7.2, au);
  },
  camera(view, count, cam) {
    aR = view.phone ? 3.6 : 6.2;
    aFog = view.phone ? 0.62 : 1;
    cam.fov = FOV;
    const d = distFor(view.h, view.cardPx);
    cam.position.set(0, 0, d);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    void count;
  },
  marker(count) {
    const top = rowY(0, count, A_ROW) + 0.64;
    const bot = rowY(count - 1, count, A_ROW) - 0.64;
    return [new THREE.Vector3(0, top, 0.02), new THREE.Vector3(0, bot, 0.02)];
  },
  guides: () => null,
  sort: false,
};

// ---------------------------------------------------------------- B: drum
const B_N = 18;
const B_R = (B_N * PITCH_W) / (2 * Math.PI);
const B_ROW = 1.22;
const B_ELEV = (17 * Math.PI) / 180;

const drum: LookLayout = {
  live: () => B_N,
  place(reel, count, u, o) {
    const th = (u * 2 * Math.PI) / B_N;
    o.x = Math.sin(th) * B_R;
    o.y = rowY(reel, count, B_ROW);
    o.z = Math.cos(th) * B_R;
    o.rx = 0;
    o.ry = th;
    o.rz = 0;
    o.scale = 1;
    const back = (1 - Math.cos(th)) / 2; // 0 front, 1 behind
    o.fade = 0.12 * smooth(0.02, 0.3, back) + 0.4 * smooth(0.3, 1, back);
  },
  camera(view, count, cam) {
    cam.fov = FOV;
    // Bigger than today's cell on desktop (the drum is a compact object),
    // never wider than the screen.
    const unit = Math.min(
      view.cardPx * (view.phone ? 1 : 1.3),
      (view.w * 0.96) / (2 * B_R + 0.9),
      (view.stageH * 0.9) / (count * B_ROW + 1.1),
    );
    const d = distFor(view.h, unit);
    const y = 0;
    cam.position.set(0, y + d * Math.sin(B_ELEV), B_R + d * Math.cos(B_ELEV));
    cam.up.set(0, 1, 0);
    cam.lookAt(0, y + 0.35 * (count > 1 ? 0.5 : 1), B_R * 0.55);
  },
  marker(count) {
    const top = rowY(0, count, B_ROW) + 0.62;
    const bot = rowY(count - 1, count, B_ROW) - 0.62;
    return [
      new THREE.Vector3(0, top, B_R + 0.02),
      new THREE.Vector3(0, bot, B_R + 0.02),
    ];
  },
  guides(count) {
    const pts: number[] = [];
    for (let r = 0; r < count; r++) {
      const y = rowY(r, count, B_ROW);
      circle(pts, B_R * 1.0, y + 0.6, 'xz');
      circle(pts, B_R * 1.0, y - 0.6, 'xz');
    }
    return lineGeometry(pts);
  },
  sort: true,
};

// ---------------------------------------------------------------- C: linked wheels
/** Cells per ring, inner to outer: the same pitch on every ring. */
const C_N = [16, 26, 36];
const cR = (ring: number) => (C_N[ring]! * PITCH_W) / (2 * Math.PI);

const wheels: LookLayout = {
  live: (reel) => C_N[reel] ?? 16,
  place(reel, count, u, o) {
    const n = C_N[reel] ?? 16;
    const r = cR(reel);
    const phi = Math.PI / 2 - (u * 2 * Math.PI) / n;
    o.x = Math.cos(phi) * r;
    o.y = Math.sin(phi) * r;
    o.z = 0;
    o.rx = 0;
    o.ry = 0;
    o.rz = phi - Math.PI / 2;
    o.scale = 1;
    const low = (1 - Math.sin(phi)) / 2; // 0 at 12 o'clock, 1 at 6
    // The recycle seam is at 6 o'clock: fade it out there.
    const seam = smooth(n / 2 - 1.6, n / 2 - 0.45, Math.abs(u));
    o.fade = Math.max(0.5 * smooth(0.15, 1, low), seam);
    void count;
  },
  camera(view, count, cam) {
    cam.fov = FOV;
    const outer = cR(count - 1) + 0.75;
    // A phone is too narrow for the whole wheel at a readable card size:
    // zoom in and frame the top of the wheel, where the marker is.
    const fit = view.phone
      ? (view.w * 1.5) / (2 * outer)
      : Math.min(view.w * 0.9, view.stageH * 0.96) / (2 * outer);
    const unit = Math.min(fit, view.cardPx * 1.1);
    const d = distFor(view.h, unit);
    const y = view.phone ? Math.max(0, outer - (view.stageH * 0.42) / unit) : 0;
    cam.position.set(0, y, d);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, y, 0);
  },
  marker(count) {
    return [
      new THREE.Vector3(0, cR(count - 1) + 0.72, 0.02),
      new THREE.Vector3(0, cR(0) - 0.66, 0.02),
    ];
  },
  guides(count) {
    const pts: number[] = [];
    for (let r = 0; r < count; r++) {
      circle(pts, cR(r) + 0.62, -0.01, 'xy', 160);
      if (r === 0) circle(pts, cR(r) - 0.62, -0.01, 'xy', 160);
    }
    circle(pts, 0.18, -0.01, 'xy', 48);
    return lineGeometry(pts);
  },
  sort: false,
};

export const LOOKS: Record<Look, LookLayout> = {
  a: curved,
  b: drum,
  c: wheels,
};

export type Variant = 'today' | Look;
export const VARIANTS: readonly Variant[] = ['today', 'a', 'b', 'c'];

export const LOOK_LABEL: Record<Variant, string> = {
  today: 'Today',
  a: 'Curved strip',
  b: 'Drum',
  c: 'Linked wheels',
};
