import { z } from '@/lib/data/schemas';

const n = z.number().finite();
const frame = z.tuple([n, n, n, n, n, n, n]);
export const CoinTracesSchema = z
  .array(
    z.object({
      profile: z.number().min(0).max(1),
      won: z.boolean(),
      fps: z.literal(60),
      frames: z.array(frame).min(2).max(600),
      impacts: z.array(n.nonnegative()),
    }),
  )
  .length(10);
export type CoinTrace = z.infer<typeof CoinTracesSchema>[number];
export type CoinGesture = number;
export const COIN_CAMERA = { fov: 44 };
// Seconds the landed coin rests, fully still, before the result (Credit or lost cards) shows:
// several traces still wobble by a fraction of a degree on their last frame.
export const COIN_REVEAL_HOLD = 0.35;
// Rim lathe profile (radius, half-height) and table height, as drawn in CoinScene.
export const COIN_RIM = [
  [0.717, 0.04],
  [0.706, 0.056],
  [0.687, 0.069],
  [0.664, 0.069],
  [0.657, 0.066],
] as const;
export const COIN_TABLE_Y = -0.006;
type Frame = CoinTrace['frames'][number];
// Face normal, normalised: 5-decimal rounding leaves |q| a hair under 1.
function faceNormal([, , , x, y, z, w]: Frame) {
  const n2 = x * x + y * y + z * z + w * w;
  return [
    (2 * (x * y - w * z)) / n2,
    (w * w + y * y - x * x - z * z) / n2,
    (2 * (y * z + w * x)) / n2,
  ] as const;
}
/** Height of the drawn rim's lowest point above the table. */
export function coinRimClearance(frame: Frame) {
  const c = Math.min(1, Math.abs(faceNormal(frame)[1]));
  const s = Math.sqrt(1 - c * c);
  return (
    frame[1] -
    Math.max(...COIN_RIM.map(([r, h]) => r * s + h * c)) -
    COIN_TABLE_Y
  );
}
export type CoinSoundEvent = {
  t: number;
  name: 'coinFlick' | 'coinWhoosh' | 'coinClink' | 'coinRattle';
  amount: number;
};
// Every toss sound, timed from the recorded trace itself: the flick at launch,
// a wind grain each time the coin passes edge-on in the air, a clink per
// impact (softer each bounce) and, while it rolls on its rim, a tick per
// quarter turn of the wobble. Sounds follow the coin the player sees.
export function coinSoundEvents(trace: CoinTrace): CoinSoundEvent[] {
  const events: CoinSoundEvent[] = [{ t: 0, name: 'coinFlick', amount: 1 }];
  let edgeSign = 0;
  let lastWhoosh = -1;
  let quarter: number | null = null;
  let lastRattle = -1;
  trace.frames.forEach((frame, i) => {
    const t = i / trace.fps;
    const [nx, ny, nz] = faceNormal(frame);
    const clearance = coinRimClearance(frame);
    if (clearance > 0.03) {
      quarter = null;
      const sign = Math.sign(ny);
      if (edgeSign && sign && sign !== edgeSign && t - lastWhoosh > 0.05) {
        events.push({
          t,
          name: 'coinWhoosh',
          amount: Math.min(1, 0.5 + frame[1] * 0.25),
        });
        lastWhoosh = t;
      }
      if (sign) edgeSign = sign;
      return;
    }
    edgeSign = 0;
    if (i / trace.fps < (trace.impacts[0] ?? Infinity)) return;
    const up = Math.sign(ny) || 1;
    const tilt = Math.asin(Math.min(1, Math.hypot(nx * up, nz * up)));
    const next = Math.floor(
      (Math.atan2(nz * up, nx * up) + Math.PI) / (Math.PI / 2),
    );
    if (
      quarter !== null &&
      next !== quarter &&
      tilt > 0.005 &&
      t - lastRattle > 0.03
    ) {
      events.push({
        t,
        name: 'coinRattle',
        amount: Math.min(1, 0.15 + tilt / 0.3),
      });
      lastRattle = t;
    }
    quarter = next;
  });
  trace.impacts.forEach((t, k) =>
    events.push({
      t,
      name: 'coinClink',
      amount: k === 0 ? 1 : Math.max(0.3, 0.75 ** k),
    }),
  );
  return events.sort((a, b) => a.t - b.t);
}
// releaseSpeed: upward px/ms over the last moments of the drag.
export function coinGesture(
  dx: number,
  dy: number,
  milliseconds: number,
  pointerType = 'touch',
  releaseSpeed?: number,
): CoinGesture | null {
  if (
    ![dx, dy, milliseconds].every(Number.isFinite) ||
    milliseconds <= 0 ||
    // A thumb moving to scroll can cross 28 px; a flick means more than that.
    dy > (pointerType === 'mouse' ? -28 : -48) ||
    -dy < Math.abs(dx) * 0.6
  )
    return null;
  const speed =
    releaseSpeed !== undefined && Number.isFinite(releaseSpeed)
      ? releaseSpeed
      : -dy / milliseconds;
  const flick = speed >= 0.25 ? Math.min(1, (speed - 0.25) / 1.5) : null;
  // A held pull also tosses on release; fingers need a longer pull than a mouse.
  const pulled =
    -dy >= (pointerType === 'mouse' ? 28 : 72)
      ? Math.min(1, (-dy - 28) / 172)
      : null;
  return flick == null && pulled == null
    ? null
    : Math.max(flick ?? 0, pulled ?? 0);
}
// Flight camera: follows part of the coin's travel so phones see a large coin,
// low-passed forwards then backwards so bounces never jolt the view (no lag).
const CAMERA_DIRECTION = [
  0,
  1.5 / Math.hypot(1.5, 2.7),
  2.7 / Math.hypot(1.5, 2.7),
];
export type CoinCameraFrame = [number, number, number, number, number, number];
export function coinCameraPath(trace: CoinTrace, offsetX = 0) {
  const path = trace.frames.map<CoinCameraFrame>((f) => {
    const aim = [(f[0] + offsetX) * 0.6, 0.7 + f[1] * 0.55, f[2] * 0.7];
    const distance = 4.4 + f[1] * 0.6;
    return [
      aim[0]! + CAMERA_DIRECTION[0]! * distance,
      aim[1]! + CAMERA_DIRECTION[1]! * distance,
      aim[2]! + CAMERA_DIRECTION[2]! * distance,
      aim[0]!,
      aim[1]!,
      aim[2]!,
    ];
  });
  for (const step of [1, -1])
    for (
      let i = step === 1 ? 1 : path.length - 2;
      i >= 0 && i < path.length;
      i += step
    )
      for (let j = 0; j < 6; j++)
        path[i]![j] = path[i - step]![j]! * 0.7 + path[i]![j]! * 0.3;
  // Move in while the coin settles, so the landed face is close when the result shows.
  const landed = coinLandedCamera(trace.frames.at(-1)!, offsetX);
  const settle = Math.min(path.length - 1, Math.round(0.7 * trace.fps));
  for (let k = 1; k <= settle; k++) {
    const t = k / settle;
    const blend = t * t * (3 - 2 * t);
    const frame = path[path.length - 1 - settle + k]!;
    for (let j = 0; j < 6; j++)
      frame[j] = frame[j]! + (landed[j]! - frame[j]!) * blend;
  }
  return path;
}
// Close view of the landed coin: the camera every result rests on.
export function coinLandedCamera(
  frame: CoinTrace['frames'][number],
  offsetX = 0,
): CoinCameraFrame {
  const x = frame[0] + offsetX;
  return [x, 1.9, frame[2] + 2.4, x, frame[1], frame[2]];
}
export function sampleCoinCamera(
  path: CoinCameraFrame[],
  fps: number,
  seconds: number,
) {
  const index = Math.max(
    0,
    Math.min(path.length - 1, (Number.isFinite(seconds) ? seconds : 0) * fps),
  );
  const a = path[Math.floor(index)]!;
  const b = path[Math.min(Math.floor(index) + 1, path.length - 1)]!;
  const alpha = index - Math.floor(index);
  return a.map(
    (value, i) => value + (b[i]! - value) * alpha,
  ) as CoinCameraFrame;
}
export function coinTraceFor(
  traces: CoinTrace[],
  headUp: boolean,
  strength: CoinGesture,
  startsOnTail = false,
) {
  const bounded = Math.max(
    0,
    Math.min(1, Number.isFinite(strength) ? strength : 0.5),
  );
  return traces
    .filter((trace) => trace.won === (startsOnTail ? !headUp : headUp))
    .reduce<CoinTrace | undefined>(
      (nearest, trace) =>
        !nearest ||
        Math.abs(trace.profile - bounded) < Math.abs(nearest.profile - bounded)
          ? trace
          : nearest,
      undefined,
    );
}
export function sampleCoinTrace(trace: CoinTrace, seconds: number) {
  const index = Math.max(
    0,
    Math.min(
      trace.frames.length - 1,
      (Number.isFinite(seconds) ? seconds : 0) * trace.fps,
    ),
  );
  const a = Math.floor(index);
  return {
    a: trace.frames[a]!,
    b: trace.frames[Math.min(a + 1, trace.frames.length - 1)]!,
    alpha: index - a,
  };
}
