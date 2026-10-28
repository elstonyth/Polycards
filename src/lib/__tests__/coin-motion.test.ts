import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import {
  COIN_CAMERA,
  CoinTracesSchema,
  coinGesture,
  coinTraceFor,
  sampleCoinTrace,
} from '../coin-motion';

describe('physical coin motion', () => {
  it('tosses a slow or paused mouse drag using distance without changing touch flicks', () => {
    expect(coinGesture(5, -100, 1500, 'mouse')).toBeCloseTo(72 / 172);
    expect(coinGesture(5, -100, 10000, 'mouse')).toBeCloseTo(72 / 172);
    expect(coinGesture(5, -100, 1500, 'touch')).toBeNull();
    expect(coinGesture(0, -200, 3000, 'mouse')).toBe(1);
    expect(coinGesture(0, -28, 2000, 'mouse')).toBe(0);
    expect(coinGesture(0, -12, 100, 'mouse')).toBeNull();
    expect(coinGesture(0, 80, 100, 'mouse')).toBeNull();
    expect(coinGesture(120, -40, 100, 'mouse')).toBeNull();
    expect(coinGesture(0, NaN, 100, 'mouse')).toBeNull();
  });
  it('keeps the full coin inside the camera through every throw and landing', () => {
    const camera = new PerspectiveCamera(COIN_CAMERA.fov, 1.1, 0.1, 40);
    camera.position.set(...COIN_CAMERA.position);
    camera.lookAt(...COIN_CAMERA.target);
    camera.updateMatrixWorld();
    const traces = CoinTracesSchema.parse(
      JSON.parse(readFileSync('public/coin-flip/motion.json', 'utf8')),
    );
    let extent = 0;
    for (const trace of traces)
      for (const frame of trace.frames) {
        const rotation = new Quaternion(...frame.slice(3));
        for (const offset of [-0.65, 0.65])
          for (let i = 0; i < 16; i++)
            for (const face of [-0.07, 0.07]) {
              const angle = (i * Math.PI) / 8;
              const point = new Vector3(
                Math.sin(angle) * 0.72,
                face,
                Math.cos(angle) * 0.72,
              )
                .applyQuaternion(rotation)
                .add(new Vector3(frame[0] + offset, frame[1], frame[2]))
                .project(camera);
              extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
            }
      }
    expect(extent).toBeLessThan(0.95);
  });
  it('ignores drags without a flick, cancellation and invalid samples', () => {
    expect(coinGesture(0, -8, 20)).toBeNull();
    expect(coinGesture(20, 50, 200)).toBeNull();
    expect(coinGesture(20, -100, 1500)).toBeNull();
    expect(coinGesture(NaN, -50, 80)).toBeNull();
    expect(coinGesture(10, -100, 80)).toBeGreaterThan(
      coinGesture(5, -50, 100)!,
    );
    expect(coinGesture(0, -500, 5)).toBe(1);
    expect(coinGesture(0, -50, 200)).toBe(0);
  });
  it('all recorded traces have a physical stable face, bounded path and continuous quaternions', () => {
    const traces = CoinTracesSchema.parse(
      JSON.parse(readFileSync('public/coin-flip/motion.json', 'utf8')),
    );
    expect(coinTraceFor(traces, true, 0.62)?.profile).toBe(0.5);
    expect(coinTraceFor(traces, false, 4)?.profile).toBe(1);
    expect(coinTraceFor(traces, true, NaN)?.profile).toBe(0.5);
    for (const profile of [0, 0.25, 0.5, 0.75, 1])
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
    for (const won of [true, false]) {
      const heights = [0, 0.25, 0.5, 0.75, 1].map((strength) =>
        Math.max(
          ...coinTraceFor(traces, won, strength)!.frames.map(
            (frame) => frame[1],
          ),
        ),
      );
      expect(heights).toEqual([...heights].sort((a, b) => a - b));
      expect(heights[4]! - heights[0]!).toBeGreaterThan(1);
    }
  });
});
