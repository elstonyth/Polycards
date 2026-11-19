// Measures a pack's art once, offline, into the numbers the model reads (see
// `PackGeometry.outline`, `.edges` and `.ridges` in pack-layout.ts). Pure
// functions over raw RGBA pixels, so a Node script with any image decoder can
// run them and they can be tested without a browser.

import type { PackGeometry, PackRidgeRun } from './pack-layout';

export type RgbaImage = {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, rows top to bottom. */
  data: ArrayLike<number>;
};

/** A run of the opaque area along one pixel row, sub-pixel, in pixels. */
export type RowEdges = { y: number; left: number; right: number };

const alphaAt = (image: RgbaImage, x: number, y: number): number =>
  image.data[(y * image.width + x) * 4 + 3] as number;

/**
 * Where alpha crosses `threshold` at each end of every pixel row, linearly
 * interpolated between pixel centres. `y` is the row's centre; rows with no
 * opaque pixel are skipped. Positions are in pixels from the left edge.
 */
export function measureRowEdges(
  image: RgbaImage,
  threshold: number,
): RowEdges[] {
  const rows: RowEdges[] = [];
  for (let y = 0; y < image.height; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < image.width; x++)
      if (alphaAt(image, x, y) >= threshold) {
        first = x;
        break;
      }
    if (first < 0) continue;
    for (let x = image.width - 1; x >= 0; x--)
      if (alphaAt(image, x, y) >= threshold) {
        last = x;
        break;
      }
    const cross = (inside: number, outside: number): number => {
      if (outside < 0 || outside >= image.width) return inside + 0.5;
      const a = alphaAt(image, inside, y);
      const b = alphaAt(image, outside, y);
      const k = a === b ? 0.5 : (a - threshold) / (a - b);
      return inside + 0.5 + (outside - inside) * k;
    };
    rows.push({
      y: y + 0.5,
      left: cross(first, first - 1),
      right: cross(last, last + 1),
    });
  }
  return rows;
}

/**
 * Sub-pixel top and bottom edges of the opaque area, as the median over the
 * middle half of the columns (corners are rounded, so they are left out).
 */
export function measureTopBottom(
  image: RgbaImage,
  threshold: number,
): { top: number; bottom: number } {
  const tops: number[] = [];
  const bottoms: number[] = [];
  const from = Math.floor(image.width * 0.25);
  const to = Math.ceil(image.width * 0.75);
  for (let x = from; x < to; x++) {
    for (let y = 0; y < image.height; y++) {
      const a = alphaAt(image, x, y);
      if (a >= threshold) {
        const b = y > 0 ? alphaAt(image, x, y - 1) : 0;
        tops.push(y + 0.5 - (a === b ? 0.5 : (a - threshold) / (a - b)));
        break;
      }
    }
    for (let y = image.height - 1; y >= 0; y--) {
      const a = alphaAt(image, x, y);
      if (a >= threshold) {
        const b = y < image.height - 1 ? alphaAt(image, x, y + 1) : 0;
        bottoms.push(y + 0.5 + (a === b ? 0.5 : (a - threshold) / (a - b)));
        break;
      }
    }
  }
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1] ?? 0;
  };
  return { top: median(tops), bottom: median(bottoms) };
}

/**
 * Drops outline rows that a straight line between their neighbours already
 * describes to within `tolerance` pixels (Douglas-Peucker on both sides).
 */
export function simplifyEdges(rows: RowEdges[], tolerance: number): RowEdges[] {
  if (rows.length <= 2) return [...rows];
  const keep = new Uint8Array(rows.length);
  keep[0] = 1;
  keep[rows.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, rows.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    const ra = rows[a] as RowEdges;
    const rb = rows[b] as RowEdges;
    let worst = -1;
    let worstAt = -1;
    for (let i = a + 1; i < b; i++) {
      const r = rows[i] as RowEdges;
      const k = (r.y - ra.y) / (rb.y - ra.y);
      const off = Math.max(
        Math.abs(r.left - (ra.left + (rb.left - ra.left) * k)),
        Math.abs(r.right - (ra.right + (rb.right - ra.right) * k)),
      );
      if (off > worst) {
        worst = off;
        worstAt = i;
      }
    }
    if (worst > tolerance && worstAt > 0) {
      keep[worstAt] = 1;
      stack.push([a, worstAt], [worstAt, b]);
    }
  }
  return rows.filter((_, i) => keep[i]);
}

/** Largest gap, in pixels, between one outline and the other mirrored. */
export function outlineMirrorError(
  front: RowEdges[],
  back: RowEdges[],
  width: number,
): number {
  const byRow = new Map(back.map((r) => [r.y, r]));
  let worst = 0;
  for (const f of front) {
    const b = byRow.get(f.y);
    if (!b) continue;
    worst = Math.max(
      worst,
      Math.abs(f.left - (width - b.right)),
      Math.abs(f.right - (width - b.left)),
    );
  }
  return worst;
}

const luminance = (data: ArrayLike<number>, i: number): number =>
  0.2126 * (data[i] as number) +
  0.7152 * (data[i + 1] as number) +
  0.0722 * (data[i + 2] as number);

/**
 * Mean luminance of each pixel row (axis 'y') or column (axis 'x'), taken
 * over the given range of the other axis (pixels, end exclusive).
 */
export function meanProfile(
  image: RgbaImage,
  axis: 'x' | 'y',
  across: [number, number],
): Float64Array {
  const length = axis === 'y' ? image.height : image.width;
  const out = new Float64Array(length);
  const [from, to] = across;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let j = from; j < to; j++) {
      const x = axis === 'y' ? j : i;
      const y = axis === 'y' ? i : j;
      sum += luminance(image.data, (y * image.width + x) * 4);
    }
    out[i] = sum / Math.max(1, to - from);
  }
  return out;
}

/** A ridge run in pixels, and how clearly the paint shows it (0..1). */
export type RidgeFit = {
  from: number;
  to: number;
  pitch: number;
  crest: number;
  strength: number;
};

/**
 * Finds the periodic ridges painted in `profile[start..end)`: the pitch with
 * the most energy, one crest (a luminance peak, in pixels, centre-based) and
 * the stretch where the ridges actually show. The profile is detrended first
 * so the foil's broad shading does not count.
 */
export function fitRidges(
  profile: ArrayLike<number>,
  start: number,
  end: number,
  pitchRange: [number, number] = [8, 24],
): RidgeFit {
  const n = end - start;
  const window = Math.round(pitchRange[1] * 1.5);
  const detrended = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - window; j <= i + window; j++) {
      if (j < 0 || j >= n) continue;
      sum += profile[start + j] as number;
      count++;
    }
    detrended[i] = (profile[start + i] as number) - sum / count;
  }
  let best = { pitch: pitchRange[0], re: 0, im: 0, power: -1 };
  for (let pitch = pitchRange[0]; pitch <= pitchRange[1]; pitch += 0.02) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * (start + i + 0.5)) / pitch;
      re += (detrended[i] as number) * Math.cos(angle);
      im += (detrended[i] as number) * Math.sin(angle);
    }
    const power = re * re + im * im;
    if (power > best.power) best = { pitch, re, im, power };
  }
  // x(p) ~ A cos(2 pi (p - crest) / pitch), with p the pixel centre.
  let crest = (Math.atan2(best.im, best.re) * best.pitch) / (2 * Math.PI);
  crest = ((crest % best.pitch) + best.pitch) % best.pitch;

  // Where the ridges show: local amplitude at this pitch over one pitch.
  const span = Math.max(2, Math.round(best.pitch));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let re = 0;
    let im = 0;
    for (let j = i - span; j <= i + span; j++) {
      if (j < 0 || j >= n) continue;
      const angle = (2 * Math.PI * (start + j + 0.5)) / best.pitch;
      re += (detrended[j] as number) * Math.cos(angle);
      im += (detrended[j] as number) * Math.sin(angle);
    }
    local[i] = Math.hypot(re, im);
  }
  let peak = 0;
  let peakAt = 0;
  for (let i = 0; i < n; i++)
    if ((local[i] as number) > peak) {
      peak = local[i] as number;
      peakAt = i;
    }
  let lo = peakAt;
  let hi = peakAt;
  while (lo > 0 && (local[lo - 1] as number) > peak * 0.45) lo--;
  while (hi < n - 1 && (local[hi + 1] as number) > peak * 0.45) hi++;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += (detrended[i] as number) ** 2;
  const strength =
    energy > 0 ? Math.min(1, (2 * best.power) / (n * energy)) : 0;

  // Refine: snap each predicted crest inside the run to the nearest painted
  // peak (sub-pixel), then fit a straight line through them. Painted ridges
  // drift a little; this keeps the relief on the paint end to end.
  const peaks: Array<[number, number]> = [];
  const firstK = Math.ceil((start + lo - crest) / best.pitch);
  for (let k = firstK; crest + k * best.pitch < start + hi + 1; k++) {
    const guess = crest + k * best.pitch - 0.5 - start; // index space
    const reach = best.pitch / 3;
    let top = -Infinity;
    let at = -1;
    for (
      let i = Math.ceil(guess - reach);
      i <= Math.floor(guess + reach);
      i++
    ) {
      if (i < 1 || i >= n - 1) continue;
      if ((detrended[i] as number) > top) {
        top = detrended[i] as number;
        at = i;
      }
    }
    if (at < 1) continue;
    const l = detrended[at - 1] as number;
    const c = detrended[at] as number;
    const r = detrended[at + 1] as number;
    const bend = l - 2 * c + r;
    const shift = bend < 0 ? (0.5 * (l - r)) / bend : 0;
    peaks.push([k, start + at + 0.5 + Math.max(-0.5, Math.min(0.5, shift))]);
  }
  let pitch = best.pitch;
  if (peaks.length >= 3) {
    const mk = peaks.reduce((s, [k]) => s + k, 0) / peaks.length;
    const mp = peaks.reduce((s, [, p]) => s + p, 0) / peaks.length;
    let num = 0;
    let den = 0;
    for (const [k, p] of peaks) {
      num += (k - mk) * (p - mp);
      den += (k - mk) ** 2;
    }
    if (den > 0) {
      pitch = num / den;
      crest = mp - pitch * mk;
      crest = ((crest % pitch) + pitch) % pitch;
    }
  }
  return {
    from: start + lo,
    to: start + hi + 1,
    pitch,
    crest,
    strength,
  };
}

/**
 * Everything `PackGeometry` can carry beyond the hand-made layout file,
 * measured from the BACK art (same frame as the file) with the front used to
 * check the mirror and to steady the crimp ridges.
 */
export function measurePackArt(
  geometry: PackGeometry,
  front: RgbaImage,
  back: RgbaImage,
  tolerance = 0.2,
): {
  outline: Array<[number, number, number]>;
  edges: { top: number; bottom: number };
  ridges: NonNullable<PackGeometry['ridges']>;
  mirrorError: number;
} {
  const { width, height } = back;
  const threshold = geometry.alphaThreshold;
  const backRows = measureRowEdges(back, threshold);
  const frontRows = measureRowEdges(front, threshold);
  const edges = measureTopBottom(back, threshold);
  // Rows within a pixel and a half of the sealed edges are anti-aliased; the
  // first and last full rows stand in for the edge rows.
  const inner = backRows.filter(
    (r) => r.y > edges.top + 1.5 && r.y < edges.bottom - 1.5,
  );
  const firstRow = inner[0];
  const lastRow = inner[inner.length - 1];
  if (!firstRow || !lastRow) throw new Error('Pack art has no opaque rows.');
  const withEnds = [
    { ...firstRow, y: edges.top },
    ...inner,
    { ...lastRow, y: edges.bottom },
  ];
  const simplified = simplifyEdges(withEnds, tolerance);
  const outline = simplified.map(
    (r) =>
      [r.y / height, r.left / width, r.right / width] as [
        number,
        number,
        number,
      ],
  );

  // Crimp ridges run across the pack: average rows over the plain middle of
  // each face (clear of the fin), front and back together.
  const crimpProfile = (image: RgbaImage, x0: number, x1: number) =>
    meanProfile(image, 'y', [Math.round(x0 * width), Math.round(x1 * width)]);
  const fin = geometry.finSeal;
  const backAcross =
    fin.x1 + 0.03 < 0.9 ? [fin.x1 + 0.03, 0.9] : [0.1, fin.x0 - 0.03];
  const a = crimpProfile(
    back,
    backAcross[0] as number,
    backAcross[1] as number,
  );
  const b = crimpProfile(
    front,
    1 - (backAcross[1] as number),
    1 - (backAcross[0] as number),
  );
  const crimps = a.map((value, i) => value + (b[i] as number));
  const toRun = (fit: RidgeFit, size: number): PackRidgeRun => ({
    from: fit.from / size,
    to: fit.to / size,
    pitch: fit.pitch / size,
    // Already measured from the image edge (pixel centres sit at i + 0.5).
    crest: fit.crest / size,
  });
  const top = fitRidges(
    crimps,
    Math.round(edges.top),
    Math.round(geometry.crimpTop.y1 * height),
  );
  const bottom = fitRidges(
    crimps,
    Math.round(geometry.crimpBottom.y0 * height),
    Math.round(edges.bottom),
  );
  // The fin's ridges run down the pack: average columns over the belly.
  const finProfile = meanProfile(back, 'x', [
    Math.round(0.2 * height),
    Math.round(0.8 * height),
  ]);
  const finFit = fitRidges(
    finProfile,
    Math.round(fin.x0 * width),
    Math.round(fin.x1 * width),
    [8, 20],
  );
  return {
    outline,
    edges: { top: edges.top / height, bottom: edges.bottom / height },
    ridges: {
      top: toRun(top, height),
      bottom: toRun(bottom, height),
      fin: toRun(finFit, width),
    },
    mirrorError: outlineMirrorError(frontRows, backRows, width),
  };
}
