import { describe, expect, it } from 'vitest';

import {
  GPU_CAP_DESKTOP_BYTES,
  GPU_CAP_PHONE_BYTES,
} from '../runtime/stage-residency';
import { drawingBufferBytes } from '../runtime/stage-scene';
import {
  planSpinHandles,
  quarterBytes,
  quarterSize,
  spinMemory,
  spinPrintTransientBytes,
  type SpinMemoryPack,
} from '../stage-spin-memory';

/**
 * The 11 half pictures' sizes from `pack-3d/catalog/pack-3d-manifest.ts`
 * (restated: this folder may not import pack-3d outside runtime/; the bench
 * reads the real manifest).
 */
const HALF: Record<string, [number, number]> = {
  '151': [449, 833],
  cr: [427, 833],
  'delta-reign': [457, 833],
  '30th-celebration': [369, 737],
  ah: [463, 833],
  'bronze-pack': [463, 833],
  'silver-pack': [463, 833],
  'gold-pack': [460, 833],
  'platinum-pack': [466, 833],
  'diamond-pack': [459, 833],
  'poncho-pack': [465, 833],
};
const PACK_3D_ASSETS = Object.fromEntries(
  Object.entries(HALF).map(([id, [halfWidth, halfHeight]]) => [
    id,
    { halfWidth, halfHeight },
  ]),
);
const PACKS = Object.values(PACK_3D_ASSETS);
/** The studio PMREM as the step 1 QA measured it (the bench prints the exact figure). */
const ENV = 6e6;
const PHONE_BUFFER = drawingBufferBytes(780, 1432, 0); // 390x716 panel at DPR 2
const DESKTOP_1X = drawingBufferBytes(1440, 828, 4); // MSAA x4 below DPR 1.5
const DESKTOP_2X = drawingBufferBytes(2880, 1656, 0);

const packs = (
  front: (k: number) => SpinMemoryPack['front'],
  back = true,
): SpinMemoryPack[] =>
  PACKS.map((a, k) => ({
    halfW: a.halfWidth,
    halfH: a.halfHeight,
    front: front(k),
    back,
  }));
const biggest = PACKS.reduce((m, a) =>
  a.halfWidth * a.halfHeight > m.halfWidth * m.halfHeight ? a : m,
);
const PRINT = { halfW: biggest.halfWidth, halfH: biggest.halfHeight };

describe('spin back sizes (10.5)', () => {
  it('quarter backs are half of back-half.webp each way, 0.36 to 0.52 MB, 5.46 MB for all 11', () => {
    const a = PACK_3D_ASSETS['bronze-pack']!;
    expect(quarterSize(a.halfWidth, a.halfHeight)).toEqual([232, 417]);
    const each = PACKS.map((p) => quarterBytes(p.halfWidth, p.halfHeight));
    expect(Math.min(...each)).toBeGreaterThan(0.36e6);
    expect(Math.max(...each)).toBeLessThan(0.53e6);
    expect(each.reduce((s, b) => s + b, 0) / 1e6).toBeCloseTo(5.46, 1);
    expect(spinPrintTransientBytes(466, 833) / 1e6).toBeCloseTo(2.33, 1);
  });
});

describe('the phone cap (40 MB) in the spin', () => {
  it("10.5's plan as built (11 handles at half) does NOT fit", () => {
    const m = spinMemory({
      bufferBytes: PHONE_BUFFER,
      environmentBytes: ENV,
      packs: packs(() => 'half'),
      printing: PRINT,
    });
    expect(m.total).toBeGreaterThan(GPU_CAP_PHONE_BYTES);
  });

  it('the rule built here fits, printing included: 4 resident halves, quarter spin handles for the rest', () => {
    const m = spinMemory({
      bufferBytes: PHONE_BUFFER,
      environmentBytes: ENV,
      packs: packs((k) => (k < 4 ? 'half' : 'quarter')),
      printing: PRINT,
    });
    expect(m.total).toBeLessThan(GPU_CAP_PHONE_BYTES);
  });
});

describe('the desktop cap (96 MB) in the spin', () => {
  it('1x with MSAA holds every pack at half with its back', () => {
    const m = spinMemory({
      bufferBytes: DESKTOP_1X,
      environmentBytes: ENV,
      packs: packs(() => 'half'),
      printing: PRINT,
    });
    expect(m.total).toBeLessThan(GPU_CAP_DESKTOP_BYTES);
  });

  it('retina: the 7 resident halves plus the promoted full front at rest, quarters for the rest', () => {
    const m = spinMemory({
      bufferBytes: DESKTOP_2X,
      environmentBytes: ENV,
      packs: packs((k) => (k === 0 ? 'half+full' : k < 7 ? 'half' : 'quarter')),
      printing: PRINT,
    });
    expect(m.total).toBeLessThan(GPU_CAP_DESKTOP_BYTES);
  });
});

describe('planSpinHandles', () => {
  const ids = Object.keys(HALF);
  const input = (
    fixedBytes: number,
    capBytes: number,
    residentIds: string[],
  ) => ({
    packs: ids.map((id, k) => ({
      id,
      halfW: HALF[id]![0],
      halfH: HALF[id]![1],
      distance: k,
    })),
    resident: new Map(residentIds.map((id) => [id, 'half' as const])),
    fixedBytes,
    capBytes,
  });
  const total = (plan: Map<string, SpinMemoryPack['front']>, fixed: number) =>
    spinMemory({
      bufferBytes: fixed,
      environmentBytes: 0,
      packs: ids.map((id) => ({
        halfW: HALF[id]![0],
        halfH: HALF[id]![1],
        front: plan.get(id)!,
        back: true,
      })),
      printing: PRINT,
    }).total;

  it('phone: keeps the residency, quarters elsewhere, under the cap with every back and a print', () => {
    const fixed = PHONE_BUFFER + ENV;
    const plan = planSpinHandles(
      input(fixed, GPU_CAP_PHONE_BYTES, ids.slice(0, 4)),
    );
    for (const id of ids.slice(0, 4)) expect(plan.get(id)).toBe('half');
    expect(
      [...plan.values()].filter((v) => v === 'quarter').length,
    ).toBeGreaterThan(0);
    expect(total(plan, fixed)).toBeLessThanOrEqual(GPU_CAP_PHONE_BYTES);
  });

  it('desktop 1x: every pack at half', () => {
    const fixed = DESKTOP_1X + ENV;
    const plan = planSpinHandles(
      input(fixed, GPU_CAP_DESKTOP_BYTES, ids.slice(0, 7)),
    );
    expect([...plan.values()].every((v) => v === 'half')).toBe(true);
    expect(total(plan, fixed)).toBeLessThanOrEqual(GPU_CAP_DESKTOP_BYTES);
  });

  it('upgrades nearest the centre first', () => {
    const fixed = PHONE_BUFFER + ENV;
    const plan = planSpinHandles(
      input(fixed, GPU_CAP_PHONE_BYTES, ids.slice(0, 4)),
    );
    const order = ids.slice(4).map((id) => plan.get(id));
    const firstQuarter = order.indexOf('quarter');
    expect(order.slice(firstQuarter).every((v) => v === 'quarter')).toBe(true);
  });
});
