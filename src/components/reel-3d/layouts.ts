// Where each cell sits in the 3D reel (the curved strip, look A; the drum and
// linked wheels were dropped 26 Nov 2026). A cell is
// addressed by its offset `u` from the winning marker, in cells (u > 0 = still
// arriving; cells stream right to left). Everything here is pure geometry.
import * as THREE from 'three';
import { CARD_W } from './shaders';

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
  /** The DOM reel's cell height (the spin page's cellSize). */
  cardPx: number;
  phone: boolean;
};

export type LookLayout = {
  /** Cells alive per reel; offsets covered are [-live/2, live/2). */
  live(reel: number, count: number): number;
  place(reel: number, count: number, u: number, out: Placement): void;
  camera(view: View, count: number, cam: THREE.PerspectiveCamera): void;
  marker(count: number): [THREE.Vector3, THREE.Vector3];
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const FOV = 30;
const TAN = Math.tan(((FOV / 2) * Math.PI) / 180);
/** Camera distance that makes 1 world unit = `unitPx` CSS px at depth 0. */
const distFor = (h: number, unitPx: number) => h / unitPx / (2 * TAN);

/** Row pitch in card heights: the DOM stack's strip frame (+16 px) and gap. */
let aRow = 1.45;
const rowY = (reel: number, count: number, gap: number) =>
  ((count - 1) / 2 - reel) * gap;
/** Arc radius and fog reach; a phone sees ±3 cells, so it curves tighter. */
let aR = 6.2;
let aFog = 1;

export const CURVED: LookLayout = {
  live: () => 16,
  place(reel, count, u, o) {
    const th = (u * PITCH_W) / aR;
    const au = Math.abs(u) / aFog;
    o.x = Math.sin(th) * aR;
    o.y = rowY(reel, count, aRow);
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
    aRow = (view.cardPx + 16 + (view.phone ? 12 : 16)) / view.cardPx;
    cam.fov = FOV;
    const d = distFor(view.h, view.cardPx);
    cam.position.set(0, 0, d);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    void count;
  },
  marker(count) {
    const top = rowY(0, count, aRow) + 0.64;
    const bot = rowY(count - 1, count, aRow) - 0.64;
    return [new THREE.Vector3(0, top, 0.02), new THREE.Vector3(0, bot, 0.02)];
  },
};
