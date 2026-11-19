import { describe, expect, it } from 'vitest';

import {
  NO_PROMOTION,
  PROMOTE_AFTER_MS,
  RESIDENCY_DESKTOP,
  RESIDENCY_PHONE,
  initialDirection,
  nextDirection,
  nextPromotion,
  planResidency,
  textureBudgetBytes,
  textureBytes,
  type DirectionState,
  type ResidencyConfig,
  type ResidentInfo,
} from '../runtime/stage-residency';

const HALF = textureBytes(463, 833); // ~2.06 MB
const FULL = textureBytes(925, 1666); // ~8.2 MB
const bytes = (_i: number, res: 'half' | 'full') =>
  res === 'full' ? FULL : HALF;
const ELEVEN = Array.from({ length: 11 }, (_, i) => i);

/** Drives the planner like the runtime does: resident set follows the plan. */
function simulator(
  config: Readonly<ResidencyConfig>,
  opts: { budget?: number; indices?: readonly number[]; start?: number } = {},
) {
  const resident = new Map<number, ResidentInfo>();
  const full = new Set<number>();
  let dir: DirectionState = initialDirection(opts.start ?? 0);
  let loads = 0;
  let disposes = 0;
  let peakCount = 0;
  let peakBytes = 0;
  const step = (track: number, now: number, promote: number | null = null) => {
    dir = nextDirection(dir, track);
    const plan = planResidency({
      indices: opts.indices ?? ELEVEN,
      track,
      direction: dir.dir,
      config,
      promote,
      budgetBytes: opts.budget ?? 1e12,
      bytes,
      resident,
      now,
    });
    for (const i of [...resident.keys()]) {
      if (!plan.want.has(i)) {
        resident.delete(i);
        full.delete(i);
        disposes++;
      }
    }
    for (const [i, w] of plan.want) {
      if (!resident.has(i)) {
        resident.set(i, { lastNeeded: -Infinity });
        loads++;
      }
      if (w.full && !full.has(i)) {
        full.add(i);
        loads++;
      }
      if (!w.full) full.delete(i);
    }
    for (const i of plan.stamp) {
      const r = resident.get(i);
      if (r) r.lastNeeded = now;
    }
    peakCount = Math.max(peakCount, resident.size);
    peakBytes = Math.max(peakBytes, plan.bytes);
    return plan;
  };
  return {
    step,
    resident,
    get loads() {
      return loads;
    },
    get disposes() {
      return disposes;
    },
    get peakCount() {
      return peakCount;
    },
    get peakBytes() {
      return peakBytes;
    },
  };
}

describe('planResidency', () => {
  it('holds the drawn packs, nearest first', () => {
    const phone = simulator(RESIDENCY_PHONE, { start: 5 });
    expect([...phone.step(5, 0).want.keys()].sort((a, b) => a - b)).toEqual([
      4, 5, 6,
    ]);
    const desk = simulator(RESIDENCY_DESKTOP, { start: 5 });
    const want = [...desk.step(5, 0).want.keys()].sort((a, b) => a - b);
    // +-2 drawn plus +-3 prefetched
    expect(want).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('a pack half way is required on both sides', () => {
    const phone = simulator(RESIDENCY_PHONE);
    const p = phone.step(4.5, 0);
    expect(p.required.sort((a, b) => a - b)).toEqual([3, 4, 5, 6]);
  });

  it('never goes over the count caps on full sweeps there and back', () => {
    for (const config of [RESIDENCY_PHONE, RESIDENCY_DESKTOP]) {
      const sim = simulator(config);
      let now = 0;
      for (let lap = 0; lap < 3; lap++) {
        for (let t = 0; t <= 10; t += 0.05) sim.step(t, (now += 16));
        for (let t = 10; t >= 0; t -= 0.05) sim.step(t, (now += 16));
      }
      expect(sim.peakCount).toBeLessThanOrEqual(config.maxResident);
    }
    expect(RESIDENCY_PHONE.maxResident).toBe(4);
    expect(RESIDENCY_DESKTOP.maxResident).toBe(7);
  });

  it('a direction flip with hysteresis still holds 4 or fewer on a phone', () => {
    const sim = simulator(RESIDENCY_PHONE);
    let now = 0;
    for (let t = 0; t <= 3; t += 0.1) sim.step(t, (now += 16));
    for (let t = 3; t >= 1.2; t -= 0.1) {
      sim.step(t, (now += 16));
      expect(sim.resident.size).toBeLessThanOrEqual(4);
    }
  });

  it('never goes over the byte budget, at any track or budget', () => {
    for (const config of [RESIDENCY_PHONE, RESIDENCY_DESKTOP]) {
      for (const budget of [
        0,
        HALF - 1,
        HALF,
        3 * HALF,
        5 * HALF + FULL,
        40e6,
      ]) {
        const sim = simulator(config, { budget });
        let now = 0;
        for (let t = 0; t <= 10; t += 0.13) {
          const p = sim.step(t, (now += 16), Math.round(t));
          expect(p.bytes).toBeLessThanOrEqual(budget);
        }
      }
    }
  });

  it('a tight budget keeps the centre first', () => {
    const sim = simulator(RESIDENCY_DESKTOP, { budget: HALF });
    expect([...sim.step(6, 0).want.keys()]).toEqual([6]);
  });

  it('drops packs at the dispose distance', () => {
    const sim = simulator(RESIDENCY_PHONE);
    sim.step(5, 0);
    sim.step(8, 5000);
    for (const i of sim.resident.keys())
      expect(Math.abs(i - 8)).toBeLessThan(3);
  });

  it('does not thrash when wobbling across a boundary', () => {
    for (const config of [RESIDENCY_PHONE, RESIDENCY_DESKTOP]) {
      const sim = simulator(config, { start: 5 });
      let now = 0;
      sim.step(5, now);
      for (let k = 0; k < 4; k++) {
        sim.step(5.4, (now += 100));
        sim.step(5.6, (now += 100));
      }
      const loads = sim.loads;
      const disposes = sim.disposes;
      for (let k = 0; k < 40; k++) {
        sim.step(5.4, (now += 100));
        sim.step(5.6, (now += 100));
      }
      expect(sim.loads - loads).toBe(0);
      expect(sim.disposes - disposes).toBe(0);
    }
  });

  it('does not thrash when swiping back and forth between two packs', () => {
    for (const config of [RESIDENCY_PHONE, RESIDENCY_DESKTOP]) {
      const sim = simulator(config, { start: 5 });
      let now = 0;
      const swipe = (from: number, to: number) => {
        for (let k = 1; k <= 20; k++)
          sim.step(from + ((to - from) * k) / 20, (now += 16));
        for (let k = 0; k < 30; k++) sim.step(to, (now += 16)); // ~0.5 s at rest
      };
      swipe(5, 6);
      swipe(6, 5);
      const loads = sim.loads;
      const disposes = sim.disposes;
      for (let k = 0; k < 20; k++) {
        swipe(5, 6);
        swipe(6, 5);
      }
      expect(sim.loads - loads).toBe(0);
      expect(sim.disposes - disposes).toBe(0);
    }
  });

  it('prefetches in the drag direction once the trailing pack is stale', () => {
    const sim = simulator(RESIDENCY_PHONE, { start: 5 });
    let now = 0;
    for (let k = 1; k <= 20; k++) sim.step(5 + k / 20, (now += 16));
    sim.step(6, (now += 16));
    expect(sim.resident.has(8)).toBe(false); // 4 is still protected
    sim.step(6, (now += RESIDENCY_PHONE.protectMs + 1));
    expect(sim.resident.has(8)).toBe(true);
    expect(sim.resident.has(4)).toBe(false);
    expect(sim.resident.size).toBeLessThanOrEqual(4);
  });

  it('holds the promoted pack at full and half, or half when it does not fit', () => {
    const sim = simulator(RESIDENCY_DESKTOP);
    const p = sim.step(5, 0, 5);
    expect(p.want.get(5)).toEqual({ full: true });
    expect(p.want.get(4)).toEqual({ full: false });
    const tight = simulator(RESIDENCY_DESKTOP, { budget: 3 * HALF });
    expect(tight.step(5, 0, 5).want.get(5)).toEqual({ full: false });
  });

  it('only plans packs that exist (mixed rows, list ends)', () => {
    const sim = simulator(RESIDENCY_PHONE, { indices: [0, 2, 3] });
    expect([...sim.step(0, 0).want.keys()].sort()).toEqual([0]);
    // 0 stays resident: |0 - 2| <= 3 (hysteresis)
    expect([...sim.step(2, 1).want.keys()].sort()).toEqual([0, 2, 3]);
    expect([...sim.step(3.5, 5000).want.keys()].sort()).toEqual([2, 3]);
    expect(
      simulator(RESIDENCY_PHONE, { indices: [] }).step(0, 0).want.size,
    ).toBe(0);
  });

  it('budgets from the plan caps', () => {
    expect(textureBudgetBytes(false, 18e6)).toBe(22e6);
    expect(textureBudgetBytes(true, 62e6)).toBe(34e6);
    expect(textureBudgetBytes(false, 50e6)).toBe(0);
  });
});

describe('nextDirection', () => {
  it('ratchets: flips only after half a pack against it', () => {
    let s = initialDirection(5);
    s = nextDirection(s, 5.3);
    expect(s.dir).toBe(0);
    s = nextDirection(s, 5.6);
    expect(s.dir).toBe(1);
    s = nextDirection(s, 6.2);
    s = nextDirection(s, 5.9);
    expect(s.dir).toBe(1);
    s = nextDirection(s, 5.6);
    expect(s.dir).toBe(-1);
  });
});

describe('nextPromotion', () => {
  it('promotes 300 ms after settling and demotes off centre', () => {
    let s = { ...NO_PROMOTION };
    s = nextPromotion(s, 3, 0, true);
    s = nextPromotion(s, 3, 16, true);
    expect(s.index).toBeNull();
    s = nextPromotion(s, 3, 16 + PROMOTE_AFTER_MS, true);
    expect(s.index).toBe(3);
    s = nextPromotion(s, 3.3, 400, true); // still the centred pack
    expect(s.index).toBe(3);
    s = nextPromotion(s, 3.6, 420, true);
    expect(s.index).toBeNull();
  });

  it('is off when disabled', () => {
    let s = { ...NO_PROMOTION };
    for (let t = 0; t < 1000; t += 16) s = nextPromotion(s, 2, t, false);
    expect(s.index).toBeNull();
  });

  it('is deterministic', () => {
    const run = () => {
      let s = { ...NO_PROMOTION };
      const out: (number | null)[] = [];
      for (let t = 0; t < 2000; t += 16) {
        s = nextPromotion(s, t < 900 ? 2 : 2 + (t - 900) / 1000, t, true);
        out.push(s.index);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
