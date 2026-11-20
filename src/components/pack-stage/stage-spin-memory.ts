/**
 * Pack stage, step 2: GPU memory arithmetic for the spin (plan-step2.md 10.5,
 * 10.14) in the catalogue's units (RGBA8 with mips, w x h x 16/3; decimal MB
 * as `stage-residency` counts). Pure.
 *
 * Finding (integration-notes.md): a spin back lives on its pack's catalogue
 * handle, which also holds that pack's front. 10.5's phone figure (35.68 MB)
 * counts 11 quarter backs but only the 4 resident half fronts; holding 11
 * handles at half resolution is about 13.4 + 6 + 22 + 5.5 + 2.3 = 49 MB, over
 * the 40 MB cap. The rule built here instead (`planSpinHandles`): the step 1
 * residency keeps its half (and promoted full) fronts; every other pack of
 * the set holds a quarter "spin handle" (front-half drawn at half size, about
 * 0.5 MB), upgraded to half where the cap allows; every handle carries a
 * quarter spin back. In the row a pack is about 436 device px tall on a DPR 2
 * phone, so a quarter front (417 px) is 1:1 there.
 */
import { textureBytes } from './runtime/stage-residency';

/** Quarter size from a half picture (half of `*-half.webp` each way). */
export function quarterSize(halfW: number, halfH: number): [number, number] {
  return [Math.round(halfW / 2), Math.round(halfH / 2)];
}

/** One spin back (or quarter front) on the GPU. */
export function quarterBytes(halfW: number, halfH: number): number {
  const [w, h] = quarterSize(halfW, halfH);
  return textureBytes(w, h);
}

/**
 * Transient CPU memory of one spin back print (10.5): the decoded
 * `back-half.webp` (no mips) + the quarter plate canvas + the print canvas.
 * At most one print is alive at a time.
 */
export function spinPrintTransientBytes(halfW: number, halfH: number): number {
  const [w, h] = quarterSize(halfW, halfH);
  return halfW * halfH * 4 + 2 * w * h * 4;
}

export type SpinMemoryPack = {
  halfW: number;
  halfH: number;
  /** Which front this pack's handle holds. */
  front: 'none' | 'quarter' | 'half' | 'half+full';
  /** A spin back is on the handle. */
  back: boolean;
};

export type SpinMemory = {
  buffer: number;
  environment: number;
  fronts: number;
  backs: number;
  print: number;
  total: number;
};

/** The figure `gpuBytesEstimate` reports, with the print transient on top when printing. */
export function spinMemory(o: {
  bufferBytes: number;
  environmentBytes: number;
  packs: readonly SpinMemoryPack[];
  printing: { halfW: number; halfH: number } | null;
}): SpinMemory {
  let fronts = 0;
  let backs = 0;
  for (const p of o.packs) {
    if (p.front === 'quarter') fronts += quarterBytes(p.halfW, p.halfH);
    if (p.front === 'half' || p.front === 'half+full')
      fronts += textureBytes(p.halfW, p.halfH);
    if (p.front === 'half+full')
      fronts += textureBytes(p.halfW * 2, p.halfH * 2);
    if (p.back) backs += quarterBytes(p.halfW, p.halfH);
  }
  const print = o.printing
    ? spinPrintTransientBytes(o.printing.halfW, o.printing.halfH)
    : 0;
  return {
    buffer: o.bufferBytes,
    environment: o.environmentBytes,
    fronts,
    backs,
    print,
    total: o.bufferBytes + o.environmentBytes + fronts + backs + print,
  };
}

export type SpinHandlePlanInput = {
  /** Every pack of the attached set. `distance`: from the centre (wrapped). */
  packs: readonly {
    id: string;
    halfW: number;
    halfH: number;
    distance: number;
  }[];
  /** The step 1 residency's set at spin 0 (kept as it is). */
  resident: ReadonlyMap<string, 'half' | 'half+full'>;
  /** Drawing buffer + environment. */
  fixedBytes: number;
  capBytes: number;
};

/**
 * The handle every pack holds through the spin, planned at spin 0 and frozen
 * while it moves (so the spin never loads a texture): the residency's packs
 * keep their fronts; every other pack gets a quarter spin handle, upgraded to
 * a half one, nearest the centre first, while the whole spin (all spin backs
 * and one print's transient included) stays under the cap. Desktop at 1x ends
 * with every pack at half; a phone with the residency's halves and quarters.
 */
export function planSpinHandles(
  o: SpinHandlePlanInput,
): Map<string, SpinMemoryPack['front']> {
  const out = new Map<string, SpinMemoryPack['front']>();
  let total = o.fixedBytes;
  let printPeak = 0;
  for (const p of o.packs) {
    total += quarterBytes(p.halfW, p.halfH); // its spin back
    printPeak = Math.max(printPeak, spinPrintTransientBytes(p.halfW, p.halfH));
    const r = o.resident.get(p.id);
    if (r) {
      out.set(p.id, r);
      total += textureBytes(p.halfW, p.halfH);
      if (r === 'half+full') total += textureBytes(p.halfW * 2, p.halfH * 2);
    } else {
      out.set(p.id, 'quarter');
      total += quarterBytes(p.halfW, p.halfH);
    }
  }
  const rest = o.packs
    .filter((p) => !o.resident.has(p.id))
    .sort((a, b) => a.distance - b.distance);
  for (const p of rest) {
    const extra =
      textureBytes(p.halfW, p.halfH) - quarterBytes(p.halfW, p.halfH);
    if (total + extra + printPeak > o.capBytes) break;
    total += extra;
    out.set(p.id, 'half');
  }
  return out;
}
