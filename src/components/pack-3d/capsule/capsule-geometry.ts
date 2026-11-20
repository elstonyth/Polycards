// The capsule's shapes as plain arrays (no three.js), in capsule-radius units:
// axis +y (cap up), azimuth phi from +z toward +x. Three lathes:
// - cap: a short hidden inner wall, the rounded lip at the seam, the cylinder
//   and the dome (outer radius 1);
// - glass: the outer clear shell (radius 0.996), from the bottom tip up under
//   the cap;
// - contents: the inner surface (radius 0.93) that carries the picture's
//   ticket contents.
// Only positions are stored: every shader derives the normal from the pill's
// own formula (normalize(p - (0, clamp(y, -HC, HC), 0))), which halves the
// vertex memory and keeps the shading exact at any segment count.

export type CapsuleDims = { HC: number; SEAM: number };

export type CapsuleDetail = {
  /** Segments round the axis. */
  radial: number;
  /** Segments over a quarter circle (dome, bottom hemisphere). */
  quarter: number;
  /** Rows along the glass and contents cylinders. */
  rows: number;
};

/** The same detail on desktop and phone: the silhouette's chord error stays
 *  under 0.2 px even at the picture's own size (radius ~343 px). */
export const CAPSULE_DETAIL: CapsuleDetail = {
  radial: 96,
  quarter: 24,
  rows: 12,
};

export const GLASS_RADIUS = 0.996;
export const CONTENTS_RADIUS = 0.93;

type Pt = [number, number]; // [radius, y]

function arc(
  out: Pt[],
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  n: number,
): void {
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
}

/** Cap profile, bottom (hidden inner wall) to the tip (prototype capsule.js). */
export function capProfile(
  d: CapsuleDims,
  q: CapsuleDetail = CAPSULE_DETAIL,
): Pt[] {
  const tc = 0.03,
    lr = 0.014,
    li = 0.006;
  const P: Pt[] = [];
  P.push([1 - tc, d.SEAM + 0.3]);
  P.push([1 - tc, d.SEAM + li]);
  arc(P, 1 - tc + li, d.SEAM + li, li, Math.PI, 1.5 * Math.PI, 3);
  arc(P, 1 - lr, d.SEAM + lr, lr, 1.5 * Math.PI, 2 * Math.PI, 6);
  P.push([1, (d.SEAM + lr + d.HC) / 2]);
  P.push([1, d.HC]);
  for (let i = 1; i <= q.quarter; i++) {
    const a = (i / q.quarter) * (Math.PI / 2);
    P.push([Math.cos(a), d.HC + Math.sin(a)]);
  }
  P[P.length - 1]![0] = 0;
  return P;
}

/** A pill of radius r from its bottom tip up to y = top (glass, contents). */
export function pillProfile(
  d: CapsuleDims,
  r: number,
  top: number,
  q: CapsuleDetail = CAPSULE_DETAIL,
): Pt[] {
  const P: Pt[] = [];
  for (let i = 0; i <= q.quarter; i++) {
    const a = -Math.PI / 2 + (i / q.quarter) * (Math.PI / 2);
    P.push([r * Math.cos(a), -d.HC + r * Math.sin(a)]);
  }
  P[0]![0] = 0;
  for (let i = 1; i <= q.rows; i++)
    P.push([r, -d.HC + ((top + d.HC) * i) / q.rows]);
  return P;
}

export type LatheArrays = {
  positions: Float32Array;
  index: Uint16Array;
  vertices: number;
  triangles: number;
};

/**
 * Sweeps a profile round the y axis (seam column duplicated, as three.js
 * LatheGeometry does), counter-clockwise seen from outside. Degenerate
 * triangles at the poles are dropped.
 */
export function lathe(profile: Pt[], radial: number): LatheArrays {
  const cols = radial + 1,
    rows = profile.length;
  const positions = new Float32Array(cols * rows * 3);
  for (let i = 0; i < cols; i++) {
    const phi = (i / radial) * Math.PI * 2;
    const s = Math.sin(phi),
      c = Math.cos(phi);
    for (let j = 0; j < rows; j++) {
      const [r, y] = profile[j]!;
      const o = (i * rows + j) * 3;
      positions[o] = r * s;
      positions[o + 1] = y;
      positions[o + 2] = r * c;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < radial; i++)
    for (let j = 0; j < rows - 1; j++) {
      const a = i * rows + j,
        b = a + rows,
        c = b + 1,
        d = a + 1;
      const rj = profile[j]![0],
        rj1 = profile[j + 1]![0];
      // a, b on row j; d, c on row j + 1 (profile goes upward)
      if (rj > 0) idx.push(a, b, d);
      if (rj1 > 0) idx.push(b, c, d);
    }
  if (cols * rows > 65535)
    throw new Error('capsule lathe: too many vertices for 16-bit indices');
  return {
    positions,
    index: Uint16Array.from(idx),
    vertices: cols * rows,
    triangles: idx.length / 3,
  };
}

export type CapsuleShapes = {
  cap: LatheArrays;
  glass: LatheArrays;
  contents: LatheArrays;
};

export function capsuleShapes(
  d: CapsuleDims,
  q: CapsuleDetail = CAPSULE_DETAIL,
): CapsuleShapes {
  return {
    cap: lathe(capProfile(d, q), q.radial),
    glass: lathe(pillProfile(d, GLASS_RADIUS, d.SEAM + 0.06, q), q.radial),
    contents: lathe(
      pillProfile(d, CONTENTS_RADIUS, d.SEAM + 0.02, q),
      q.radial,
    ),
  };
}

/** Bytes the shapes hold on the GPU (positions + 16-bit indices). */
export function shapeBytes(s: CapsuleShapes): number {
  return [s.cap, s.glass, s.contents].reduce(
    (sum, l) => sum + l.positions.byteLength + l.index.byteLength,
    0,
  );
}
