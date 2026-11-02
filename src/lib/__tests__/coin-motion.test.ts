import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import {
  COIN_CAMERA,
  CoinTracesSchema,
  coinCameraPath,
  coinGesture,
  coinRimClearance,
  coinSoundEvents,
  coinTraceFor,
  sampleCoinCamera,
  sampleCoinTrace,
} from '../coin-motion';

describe('physical coin motion', () => {
  it('a win and a loss of one strength take the same time and sound alike, so the toss tells nothing', () => {
    const traces = CoinTracesSchema.parse(
      JSON.parse(readFileSync('public/coin-flip/motion.json', 'utf8')),
    );
    const count = (trace: (typeof traces)[number], name: string) =>
      coinSoundEvents(trace).filter((event) => event.name === name).length;
    for (const profile of [0, 0.25, 0.5, 0.75, 1]) {
      const win = traces.find((t) => t.profile === profile && t.won)!;
      const loss = traces.find((t) => t.profile === profile && !t.won)!;
      expect(win.frames.length).toBe(loss.frames.length);
      expect(win.impacts.length).toBe(loss.impacts.length);
      win.impacts.forEach((t, i) =>
        expect(Math.abs(t - loss.impacts[i]!)).toBeLessThan(0.2),
      );
      expect(
        Math.abs(count(win, 'coinRattle') - count(loss, 'coinRattle')),
      ).toBeLessThanOrEqual(4);
    }
  });
  it('launches from the selected face and lands correctly at every strength', () => {
    const traces = CoinTracesSchema.parse(
      JSON.parse(readFileSync('public/coin-flip/motion.json', 'utf8')),
    );
    for (const startsOnTail of [false, true])
      for (const headUp of [false, true])
        for (const strength of [0, 0.25, 0.5, 0.75, 1]) {
          const trace = coinTraceFor(traces, headUp, strength, startsOnTail)!;
          const faceRotation = new Quaternion().setFromAxisAngle(
            new Vector3(1, 0, 0),
            startsOnTail ? Math.PI : 0,
          );
          const start = new Quaternion(...trace.frames[0]!.slice(3)).multiply(
            faceRotation,
          );
          const expectedStart = new Quaternion(
            Math.sin(0.32),
            0,
            0,
            Math.cos(0.32),
          ).multiply(faceRotation);
          expect(start.angleTo(expectedStart)).toBeLessThan(0.01);
          const end = new Quaternion(...trace.frames.at(-1)!.slice(3)).multiply(
            faceRotation,
          );
          const normal = new Vector3(0, 1, 0).applyQuaternion(end);
          expect(normal.y > 0).toBe(headUp);
          expect(Math.abs(normal.y)).toBeGreaterThan(0.997);
        }
  });
  it('tosses a held pull on release; fingers need a longer pull than a mouse', () => {
    expect(coinGesture(5, -100, 1500, 'mouse')).toBeCloseTo(72 / 172);
    expect(coinGesture(5, -100, 10000, 'mouse')).toBeCloseTo(72 / 172);
    expect(coinGesture(5, -100, 1500, 'touch')).toBeCloseTo(72 / 172);
    expect(coinGesture(5, -60, 1500, 'touch')).toBeNull();
    expect(coinGesture(5, -60, 1500, 'mouse')).toBeCloseTo(32 / 172);
    expect(coinGesture(0, -200, 3000, 'mouse')).toBe(1);
    expect(coinGesture(0, -28, 2000, 'mouse')).toBe(0);
    expect(coinGesture(0, -12, 100, 'mouse')).toBeNull();
    expect(coinGesture(0, 80, 100, 'mouse')).toBeNull();
    expect(coinGesture(120, -40, 100, 'mouse')).toBeNull();
    expect(coinGesture(0, NaN, 100, 'mouse')).toBeNull();
    // A fast final flick outranks a slow pull, whichever pointer made it.
    expect(coinGesture(0, -100, 2000, 'touch', 1.75)).toBe(1);
    expect(coinGesture(0, -40, 2000, 'touch', 0.1)).toBeNull();
    // A thumb on its way to scroll: fast enough, too short to mean a toss.
    expect(coinGesture(0, -40, 100, 'touch')).toBeNull();
    expect(coinGesture(0, -48, 100, 'touch')).not.toBeNull();
    expect(coinGesture(0, -40, 100, 'mouse')).not.toBeNull();
  });
  it('keeps the full coin inside the following flight camera at every stage shape', () => {
    const traces = CoinTracesSchema.parse(
      JSON.parse(readFileSync('public/coin-flip/motion.json', 'utf8')),
    );
    for (const aspect of [0.9, 1.1, 1.3, 1.8, 2.4]) {
      const camera = new PerspectiveCamera(COIN_CAMERA.fov, aspect, 0.1, 40);
      let extent = 0;
      let smallest = Infinity;
      for (const trace of traces)
        for (const offset of [-0.4, 0, 0.4]) {
          const path = coinCameraPath(trace, offset);
          trace.frames.forEach((frame, i) => {
            const view = sampleCoinCamera(path, trace.fps, i / trace.fps);
            camera.position.set(view[0], view[1], view[2]);
            camera.lookAt(view[3], view[4], view[5]);
            camera.updateMatrixWorld();
            const rotation = new Quaternion(...frame.slice(3));
            let left = Infinity;
            let right = -Infinity;
            for (let s = 0; s < 16; s++)
              for (const face of [-0.07, 0.07]) {
                const angle = (s * Math.PI) / 8;
                const point = new Vector3(
                  Math.sin(angle) * 0.72,
                  face,
                  Math.cos(angle) * 0.72,
                )
                  .applyQuaternion(rotation)
                  .add(new Vector3(frame[0] + offset, frame[1], frame[2]))
                  .project(camera);
                extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
                left = Math.min(left, point.x);
                right = Math.max(right, point.x);
              }
            smallest = Math.min(smallest, (right - left) * aspect);
          });
        }
      expect(extent).toBeLessThan(0.85);
      // The previous fixed flight camera drew the coin at about 0.44 of the stage height.
      expect(smallest).toBeGreaterThan(0.55);
    }
  });
  it('keeps the closer idle and result views inside the narrow desktop stage', () => {
    const traces = CoinTracesSchema.parse(
      JSON.parse(readFileSync('public/coin-flip/motion.json', 'utf8')),
    );
    const camera = new PerspectiveCamera(COIN_CAMERA.fov, 1.07, 0.1, 40);
    const initial = [0, 1, 0, Math.sin(0.32), 0, 0, Math.cos(0.32)];
    let extent = 0;
    for (const landed of [false, true])
      for (const frame of landed
        ? traces.map((trace) => trace.frames.at(-1)!)
        : [initial])
        for (const offset of [-0.4, 0.4]) {
          const center = new Vector3(frame[0]! + offset, frame[1]!, frame[2]!);
          camera.position.set(
            landed ? center.x : 0,
            landed ? 1.9 : 2.5,
            landed ? center.z + 2.4 : 2.7,
          );
          camera.lookAt(landed ? center : new Vector3(0, 1, 0));
          camera.updateMatrixWorld();
          if (!landed) center.y += 0.4;
          for (let i = 0; i < 32; i++)
            for (const face of [-0.07, 0.07]) {
              const angle = (i * Math.PI) / 16;
              const point = new Vector3(
                Math.sin(angle) * 0.72,
                face,
                Math.cos(angle) * 0.72,
              )
                .applyQuaternion(new Quaternion(...frame.slice(3)))
                .add(center)
                .project(camera);
              extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
            }
        }
    expect(extent).toBeLessThan(0.95);
  });
  it('ignores drags without a flick, cancellation and invalid samples', () => {
    expect(coinGesture(0, -8, 20)).toBeNull();
    expect(coinGesture(20, 50, 200)).toBeNull();
    expect(coinGesture(20, -50, 1500)).toBeNull();
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
  it('never draws the coin rim below the table', () => {
    const traces = CoinTracesSchema.parse(
      JSON.parse(readFileSync('public/coin-flip/motion.json', 'utf8')),
    );
    for (const trace of traces)
      for (const f of trace.frames)
        expect(coinRimClearance(f)).toBeGreaterThanOrEqual(0);
  });
  it('times every toss sound from the coin the player sees', () => {
    const traces = CoinTracesSchema.parse(
      JSON.parse(readFileSync('public/coin-flip/motion.json', 'utf8')),
    );
    for (const trace of traces) {
      const events = coinSoundEvents(trace);
      const end = (trace.frames.length - 1) / trace.fps;
      const of = (name: string) => events.filter((e) => e.name === name);
      expect(events[0]).toEqual({ t: 0, name: 'coinFlick', amount: 1 });
      expect(events.map((e) => e.t)).toEqual(
        events.map((e) => e.t).sort((a, b) => a - b),
      );
      expect(
        events.every((e) => e.t <= end && e.amount > 0 && e.amount <= 1),
      ).toBe(true);
      // One clink per impact, each later bounce no louder than the last.
      expect(of('coinClink').map((e) => e.t)).toEqual(trace.impacts);
      const clinks = of('coinClink').map((e) => e.amount);
      expect(clinks).toEqual([...clinks].sort((a, b) => b - a));
      // Wind only while airborne and before the first landing on this trace.
      expect(of('coinWhoosh').length).toBeGreaterThanOrEqual(2);
      expect(of('coinWhoosh').every((e) => e.t < trace.impacts[0]!)).toBe(true);
      expect(of('coinRattle').every((e) => e.t >= trace.impacts[0]!)).toBe(
        true,
      );
    }
    // The throw that rolls on the rim rattles faster as it flattens, on both faces.
    for (const won of [true, false]) {
      const rattles = coinSoundEvents(
        traces.find((t) => t.profile === 0.25 && t.won === won)!,
      ).filter((e) => e.name === 'coinRattle');
      expect(rattles.length).toBeGreaterThan(12);
      expect(rattles.at(-1)!.amount).toBeLessThan(rattles[0]!.amount);
    }
  });
});
