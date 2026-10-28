import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CoinTracesSchema, coinGesture, sampleCoinTrace } from '../coin-motion';

describe('physical coin motion', () => {
  it('ignores drags without a flick, cancellation and invalid samples', () => {
    expect(coinGesture(0, -8, 20)).toBeNull();
    expect(coinGesture(20, 50, 200)).toBeNull();
    expect(coinGesture(20, -100, 1500)).toBeNull();
    expect(coinGesture(NaN, -50, 80)).toBeNull();
    expect(coinGesture(10, -100, 80)).toBe('firm');
    expect(coinGesture(5, -50, 100)).toBe('soft');
  });
  it('all recorded traces have a physical stable face, bounded path and continuous quaternions', () => {
    const traces = CoinTracesSchema.parse(
      JSON.parse(readFileSync('public/coin-flip/motion.json', 'utf8')),
    );
    for (const profile of ['soft', 'firm'])
      for (const won of [true, false]) {
        const trace = traces.find(
          (t) => t.profile === profile && t.won === won,
        )!;
        expect(trace).toBeTruthy();
        expect(trace.impacts.length).toBeGreaterThan(0);
        const end = sampleCoinTrace(trace, 999);
        expect(end.a).toEqual(end.b);
        expect(1 - 2 * (end.a[3] ** 2 + end.a[5] ** 2) > 0).toBe(won);
        expect(end.a[1]).toBeLessThan(0.09);
        for (let i = 1; i < trace.frames.length; i++) {
          const a = trace.frames[i - 1]!;
          const b = trace.frames[i]!;
          expect(Math.abs(Math.hypot(...b.slice(3)) - 1)).toBeLessThan(0.0001);
          expect(
            Math.abs(a.slice(3).reduce((sum, n, j) => sum + n * b[j + 3]!, 0)),
          ).toBeGreaterThan(0.9);
          expect(Math.hypot(b[0], b[2])).toBeLessThan(2);
        }
      }
  });
});
