import { keyframes, spring } from 'motion-dom';
import {
  cubicBezier as motionBezier,
  easeOut as motionEaseOut,
} from 'motion-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  animate,
  cancelFrame,
  frame,
  observable,
  springGenerator,
  tweenGenerator,
} from '../stage-motion';

/**
 * The local scheduler must move the stage exactly as `motion` did. These
 * compare its generators with `motion`'s own, sample by sample, for every
 * animation the stage runs (StageTrack's settle, the provider's float-in,
 * sink, rise and pointer lean).
 */
const SETTLE = { stiffness: 260, damping: 32, restDelta: 0.001 } as const;

function motionSpring(from: number, to: number, velocity: number) {
  return spring({ keyframes: [from, to], velocity, ...SETTLE });
}

describe('springGenerator matches motion spring, sample by sample', () => {
  const cases = [
    { from: 2, to: 3, v: 0 }, // a tap on Next
    { from: 3, to: 2, v: 0 }, // a tap on Previous
    { from: 3.57, to: 4, v: 6.3 }, // a swipe released with speed
    { from: 2.2, to: 5, v: -8 }, // a fling against the travel
    { from: 3.48, to: 2, v: 0 }, // a tap that takes over mid-settle
    { from: 0, to: 10, v: 0 }, // a long jump (non-granular rest)
  ];
  for (const c of cases) {
    it(`${c.from} -> ${c.to} at ${c.v}/s`, () => {
      const m = motionSpring(c.from, c.to, c.v);
      const ours = springGenerator(c.from, c.to, { ...SETTLE, velocity: c.v });
      let doneAt = { m: -1, o: -1 };
      for (let t = 0; t <= 3000; t += 4) {
        const a = m.next(t);
        const b = ours(t);
        expect(b.value).toBeCloseTo(a.value, 9);
        if (a.done && doneAt.m < 0) doneAt = { ...doneAt, m: t };
        if (b.done && doneAt.o < 0) doneAt = { ...doneAt, o: t };
      }
      expect(doneAt.o).toBe(doneAt.m);
    });
  }

  it('also matches the overdamped and critically damped branches', () => {
    for (const damping of [2 * Math.sqrt(260), 60]) {
      const m = spring({
        keyframes: [0, 1],
        stiffness: 260,
        damping,
        restDelta: 0.001,
      });
      const ours = springGenerator(0, 1, {
        stiffness: 260,
        damping,
        restDelta: 0.001,
      });
      for (let t = 0; t <= 2000; t += 5)
        expect(ours(t).value).toBeCloseTo(m.next(t).value, 9);
    }
  });
});

describe('tweenGenerator matches motion keyframes with the same easing', () => {
  const cases = [
    {
      name: 'float-in (linear 1.1 s)',
      d: 1.1,
      ease: 'linear' as const,
      mEase: (p: number) => p,
      from: 0,
      to: 1,
    },
    {
      name: 'sink (0.4,0,1,1 over 250 ms)',
      d: 0.25,
      ease: [0.4, 0, 1, 1] as const,
      mEase: motionBezier(0.4, 0, 1, 1),
      from: 0,
      to: 1,
    },
    {
      name: 'rise (spring curve over 450 ms)',
      d: 0.45,
      ease: [0.32, 0.72, 0, 1] as const,
      mEase: motionBezier(0.32, 0.72, 0, 1),
      from: 1,
      to: 0,
    },
    {
      name: 'pointer lean in (easeOut 350 ms)',
      d: 0.35,
      ease: 'easeOut' as const,
      mEase: motionEaseOut,
      from: -0.2,
      to: 0.83,
    },
    {
      name: 'pointer lean out (easeOut 600 ms)',
      d: 0.6,
      ease: 'easeOut' as const,
      mEase: motionEaseOut,
      from: 0.83,
      to: 0,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const m = keyframes({
        keyframes: [c.from, c.to],
        duration: c.d * 1000,
        ease: c.mEase,
      });
      const ours = tweenGenerator(c.from, c.to, {
        duration: c.d,
        ease: c.ease,
      });
      for (let t = 0; t <= c.d * 1000 + 50; t += 5) {
        const a = m.next(t);
        const b = ours(t);
        // The two bezier solvers agree to 1e-9 (motion subdivides, ours
        // uses Newton steps): under a millionth of a pixel on a 430 px pack.
        expect(b.value).toBeCloseTo(a.value, 8);
        expect(b.done).toBe(a.done);
      }
    });
  }
});

describe('the scheduler', () => {
  let rafs: FrameRequestCallback[] = [];
  let clock = 0;
  beforeEach(() => {
    rafs = [];
    clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafs.push(cb);
      return rafs.length;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const tick = (ms: number) => {
    clock += ms;
    const run = rafs;
    rafs = [];
    for (const cb of run) cb(clock);
  };

  it('moves a value from the next frame, notifies listeners, then completes', () => {
    const v = observable(0);
    const seen: number[] = [];
    v.on('change', (x) => seen.push(x));
    const done = vi.fn();
    animate(v, 1, { duration: 0.1, ease: 'linear', onComplete: done });
    expect(v.get()).toBe(0);
    tick(50);
    expect(v.get()).toBeCloseTo(0.5, 9);
    tick(60);
    expect(v.get()).toBe(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe(1);
  });

  it('a new tween on a value takes over from where it is (interruption)', () => {
    const v = observable(0);
    const first = vi.fn();
    animate(v, 1, { duration: 0.2, ease: 'linear', onComplete: first });
    tick(100);
    expect(v.get()).toBeCloseTo(0.5, 9);
    animate(v, 0, { duration: 0.1, ease: 'linear' });
    tick(50);
    expect(v.get()).toBeCloseTo(0.25, 9);
    tick(60);
    expect(v.get()).toBe(0);
    expect(first).not.toHaveBeenCalled();
  });

  it('stop() freezes the value and never completes', () => {
    const v = observable(0);
    const done = vi.fn();
    const c = animate(v, 1, { duration: 0.1, onComplete: done });
    tick(50);
    c.stop();
    const at = v.get();
    tick(100);
    expect(v.get()).toBe(at);
    expect(done).not.toHaveBeenCalled();
  });

  it('runs render after update, and keeps a keepAlive render callback until cancelled', () => {
    const order: string[] = [];
    const v = observable(0);
    v.on('change', () => order.push('value'));
    const render = () => order.push('render');
    const c = animate(v, 1, { duration: 1 });
    frame.render(render, true);
    tick(16);
    tick(16);
    expect(order).toEqual(['value', 'render', 'value', 'render']);
    cancelFrame(render);
    c.stop();
    tick(16);
    expect(order.filter((x) => x === 'render')).toHaveLength(2);
    tick(16); // the loop goes idle: nothing is left to run
  });

  it('a frozen clock freezes animations (the QA page clock)', () => {
    const v = observable(0);
    animate(v, 1, { duration: 0.1, ease: 'linear' });
    tick(0);
    tick(0);
    expect(v.get()).toBe(0);
    tick(25);
    expect(v.get()).toBeCloseTo(0.25, 9);
  });
});
