import { z } from '@/lib/data/schemas';

const n = z.number().finite();
const frame = z.tuple([n, n, n, n, n, n, n]);
export const CoinTracesSchema = z
  .array(
    z.object({
      profile: z.enum(['soft', 'firm']),
      won: z.boolean(),
      fps: z.literal(60),
      frames: z.array(frame).min(2).max(600),
      impacts: z.array(n.nonnegative()),
    }),
  )
  .length(4);
export type CoinTrace = z.infer<typeof CoinTracesSchema>[number];
export type CoinGesture = 'soft' | 'firm';
export function coinGesture(
  dx: number,
  dy: number,
  milliseconds: number,
): CoinGesture | null {
  if (
    ![dx, dy, milliseconds].every(Number.isFinite) ||
    milliseconds <= 0 ||
    dy > -28 ||
    -dy < Math.abs(dx) * 0.6
  )
    return null;
  const speed = -dy / milliseconds;
  return speed >= 0.75 ? 'firm' : speed >= 0.25 ? 'soft' : null;
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
