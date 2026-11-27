// The Draw page's globe: which plane a gate flies, on which route, and how far
// along it is. Pure maths, no three.js: the scene (components/draw-globe) reads
// these numbers.
//
// A gate is a flight. It takes off when the gate opens and lands when it
// closes, so the plane's place on its route is the gate's clock.

import type { LuckyDrawTier } from '@/lib/lucky-draw';

/** The stage's height, as classes: what is left of the screen between the
 *  page's controls and the tab bar, within what a globe and an open pin need.
 *  Here, not beside the stage: its loading placeholder must not pull three in. */
export const GLOBE_STAGE =
  'h-[clamp(27rem,calc(100dvh-16.5rem),46rem)] squat:h-[max(22rem,calc(100dvh-14.5rem))] short:h-[max(15rem,calc(100dvh-9.5rem))] lg:h-[clamp(30rem,calc(100dvh-13rem),52rem)]';

/** The globe's stand-in while it loads: the same disc from the page skeleton
 *  to the first frame. Its box must be a size container (GLOBE_DISC_BOX), so
 *  the disc also fits a landscape stage shorter than it is wide. */
export const GLOBE_DISC_BOX =
  'absolute inset-0 grid place-items-center [container-type:size]';
export const GLOBE_DISC =
  'size-[min(72cqw,24rem,85cqh)] animate-pulse rounded-full bg-white/[0.04]';

export type LonLat = readonly [lon: number, lat: number];
export type Vec3 = readonly [x: number, y: number, z: number];

export type PlaneKind = 'prop' | 'jet' | 'jumbo';

/** Economy flies the turboprop, Business the jet, First the jumbo. An old gate
 *  with no tier flies Economy's. */
export function planeKind(tier: LuckyDrawTier | null): PlaneKind {
  return tier === 'first' ? 'jumbo' : tier === 'business' ? 'jet' : 'prop';
}

// Spread round the whole world, so the side facing you never carries every
// gate at once: the globe turns, and planes come round into view. No two cross
// or share an airport: their pins would sit on each other.
export const ROUTES: readonly (readonly [LonLat, LonLat])[] = [
  [
    [103.9, 1.4],
    [139.8, 35.5],
  ], // Singapore to Tokyo
  [
    [-0.5, 51.5],
    [12.5, 41.9],
  ], // London to Rome
  [
    [55.4, 25.3],
    [77.1, 28.6],
  ], // Dubai to Delhi
  [
    [-118.4, 33.9],
    [-99.1, 19.4],
  ], // Los Angeles to Mexico City
  [
    [115.9, -31.9],
    [151.2, -33.9],
  ], // Perth to Sydney
  [
    [-46.6, -23.5],
    [-77.1, -12.0],
  ], // São Paulo to Lima
  [
    [31.2, 30.1],
    [36.8, -1.3],
  ], // Cairo to Nairobi
  [
    [-157.9, 21.3],
    [177.4, -17.8],
  ], // Honolulu to Nadi
  [
    [-73.8, 40.6],
    [-21.9, 64.1],
  ], // New York to Reykjavik
  [
    [3.4, 6.5],
    [18.4, -33.9],
  ], // Lagos to Cape Town
  [
    [-123.1, 49.2],
    [-149.9, 61.2],
  ], // Vancouver to Anchorage
  [
    [37.6, 55.8],
    [28.8, 41.0],
  ], // Moscow to Istanbul
];

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** A slot for each gate, by its id: the same gate keeps its slot across
 *  re-reads. Slot `i` is route `i % ROUTES.length` in lane
 *  `floor(i / ROUTES.length)` (see routeEnds): every route's first lane fills
 *  before any gate flies beside another, and no two gates share a slot. */
export function assignRoutes(ids: readonly string[]): Map<string, number> {
  const n = ROUTES.length;
  const taken = new Set<number>();
  const out = new Map<string, number>();
  for (const id of [...ids].sort()) {
    const h = hash(id);
    let slot = 0;
    for (let k = 0; ; k++) {
      slot = Math.floor(k / n) * n + ((h + k) % n);
      if (!taken.has(slot)) break;
    }
    taken.add(slot);
    out.set(id, slot);
  }
  return out;
}

// How far each further lane flies from its route, in degrees.
const LANE_DEG = 12;

/** A slot's two airports. Lane 0 is the route itself; lane 1 runs LANE_DEG
 *  to one side of it, lane 2 to the other, lane 3 twice as far, and so on:
 *  gates sharing a route with the same times would otherwise fly as one plane. */
export function routeEnds(slot: number): readonly [LonLat, LonLat] {
  const n = ROUTES.length;
  const [from, to] = ROUTES[slot % n]!;
  const lane = Math.floor(slot / n);
  if (lane === 0) return [from, to];
  const side = lane % 2 ? 1 : -1;
  const angle = (side * Math.ceil(lane / 2) * LANE_DEG * Math.PI) / 180;
  const a = toVec(from);
  const b = toVec(to);
  // The route's great circle turns about this axis; stepping along it moves a
  // point square off the route.
  const axis = norm([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]);
  const shift = (p: Vec3): LonLat => {
    const q = norm(
      add(scale(p, Math.cos(angle)), scale(axis, Math.sin(angle))),
    );
    return [
      (Math.atan2(-q[2], q[0]) * 180) / Math.PI,
      (Math.asin(q[1]) * 180) / Math.PI,
    ];
  };
  return [shift(a), shift(b)];
}

/** How far along its route a gate's plane is, 0 at take-off to 1 landed. A
 *  plane in the air never shows parked: it holds just short of either end. */
export function flightProgress(
  startsAt: string,
  endsAt: string,
  nowMs: number,
): number {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!(nowMs < end)) return 1;
  if (!(end > start)) return 0.5;
  return Math.min(0.97, Math.max(0.03, (nowMs - start) / (end - start)));
}

/** A place on the unit globe, in the scene's axes: Y is north and longitude 0
 *  faces +X, which is where three's sphere puts the middle of the map. */
export function toVec([lon, lat]: LonLat): Vec3 {
  const lo = (lon * Math.PI) / 180;
  const la = (lat * Math.PI) / 180;
  return [
    Math.cos(la) * Math.cos(lo),
    Math.sin(la),
    -Math.cos(la) * Math.sin(lo),
  ];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

/** The point `s` of the way along the shortest path between two places. */
export function greatCircle(a: Vec3, b: Vec3, s: number): Vec3 {
  const omega = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
  if (omega < 1e-6) return a;
  const k = 1 / Math.sin(omega);
  return add(
    scale(a, Math.sin((1 - s) * omega) * k),
    scale(b, Math.sin(s * omega) * k),
  );
}

/** Where a plane is and which way it points: it climbs out, cruises `cruise`
 *  above the ground and comes down to `ground` as it lands. */
export function flightPose(
  from: LonLat,
  to: LonLat,
  s: number,
  cruise: number,
  ground: number,
): { position: Vec3; forward: Vec3; up: Vec3 } {
  const a = toVec(from);
  const b = toVec(to);
  const at = (t: number): Vec3 => {
    const c = Math.min(1, Math.max(0, t));
    return scale(
      greatCircle(a, b, c),
      1 + ground + cruise * Math.sqrt(Math.sin(Math.PI * c)),
    );
  };
  const position = at(s);
  // Parked, a plane points the way it came in.
  const ahead =
    s > 0.985
      ? add(greatCircle(a, b, 1), scale(greatCircle(a, b, 0.99), -1))
      : add(at(s + 0.004), scale(at(s - 0.004), -1));
  const up = norm(position);
  // Always level: the climb and descent are steep near either end, and a nose
  // tipped along them reads as a dive.
  const forward = norm(add(ahead, scale(up, -dot(ahead, up))));
  return { position, forward, up };
}

/** The time left as a pin has room for: "3d 01h", "05h 12m", "12m 03s". */
export function shortTimeLeft(clock: {
  d: string;
  h: string;
  m: string;
  s: string;
}): string {
  if (clock.d !== '00') return `${Number(clock.d)}d ${clock.h}h`;
  if (clock.h !== '00') return `${clock.h}h ${clock.m}m`;
  return `${clock.m}m ${clock.s}s`;
}
