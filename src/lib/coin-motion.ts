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
export const COIN_CAMERA = {
  fov: 44,
  position: [0, 4.6, 6.4] as const,
  target: [0, 1, 0.35] as const,
};
export function coinGesture(
  dx: number,
  dy: number,
  milliseconds: number,
  pointerType = 'touch',
): CoinGesture | null {
  if (
    ![dx, dy, milliseconds].every(Number.isFinite) ||
    milliseconds <= 0 ||
    dy > -28 ||
    -dy < Math.abs(dx) * 0.6
  )
    return null;
  const speed = -dy / milliseconds;
  // Mouse users can pull and hold before releasing; distance retains the charge.
  if (pointerType === 'mouse')
    return Math.min(1, Math.max((-dy - 28) / 172, (speed - 0.25) / 1.5));
  return speed >= 0.25 ? Math.min(1, (speed - 0.25) / 1.5) : null;
}
export function coinTraceFor(
  traces: CoinTrace[],
  won: boolean,
  strength: CoinGesture,
) {
  const bounded = Math.max(
    0,
    Math.min(1, Number.isFinite(strength) ? strength : 0.5),
  );
  return traces
    .filter((trace) => trace.won === won)
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
