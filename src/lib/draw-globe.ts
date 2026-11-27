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

// Every route sits in the one half of the globe the page opens on, so all the
// running gates show at once. No two cross or share an airport: their pins
// would sit on each other.
export const ROUTES: readonly (readonly [LonLat, LonLat])[] = [
  [
    [103.9, 1.4],
    [139.8, 35.5],
  ], // Singapore to Tokyo
  [
    [151.2, -33.9],
    [79.9, 6.9],
  ], // Sydney to Colombo
  [
    [100.5, 13.7],
    [77.1, 28.6],
  ], // Bangkok to Delhi
  [
    [115.9, -31.9],
    [57.7, -20.4],
  ], // Perth to Mauritius
  [
    [55.4, 25.3],
    [73.5, 4.2],
  ], // Dubai to Malé
  [
    [121.0, 14.5],
    [147.2, -9.4],
  ], // Manila to Port Moresby
  [
    [126.4, 37.5],
    [106.8, 47.8],
  ], // Seoul to Ulaanbaatar
  [
    [174.8, -37.0],
    [177.4, -17.8],
  ], // Auckland to Nadi
];

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** A route for each gate, by its id: the same gate keeps its route across
 *  re-reads. Two gates never share one while a free route is left. */
export function assignRoutes(ids: readonly string[]): Map<string, number> {
  const taken = new Set<number>();
  const out = new Map<string, number>();
  for (const id of [...ids].sort()) {
    let route = hash(id) % ROUTES.length;
    for (let i = 0; i < ROUTES.length && taken.has(route); i++) {
      route = (route + 1) % ROUTES.length;
    }
    taken.add(route);
    out.set(id, route);
  }
  return out;
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
